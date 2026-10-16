// @ts-check
// Loop until done: a task a person marks to loop, fed its failing check until the check
// passes or a cap is hit. It is the across-messages form of the Stop hook's refusal - the
// runtime sends a session back to work inside one message, this one between messages, and
// only ever because a person turned it on. Nothing here is reachable by a session's tools.

/** @typedef {import('./contract.mjs').Session} Session */
/** @typedef {import('./contract.mjs').Task} Task */
/** @typedef {import('./contract.mjs').TaskLoop} TaskLoop */
/** @typedef {import('./contract.mjs').TaskLoopState} TaskLoopState */

/** A loop that is turned on without caps gets these. @type {number} */
export const MAX_ATTEMPTS = 10;
/** Wall-clock ceiling, in minutes. @type {number} */
export const MAX_MINUTES = 120;
/** The most either cap may be set to, so a loop can never be told to run forever. */
export const CAP_LIMITS = { attempts: 100, minutes: 24 * 60 };
/** How much of a check's output is sent back to the session. */
const OUTPUT_CHARS = 4000;

/** @typedef {import('./service.mjs').Service} Service */
/** @typedef {import('./store.mjs').Store} Store */
/** @typedef {import('./runtime.mjs').Runtime} Runtime */
/** @typedef {{ok:boolean, code:number|null, output:string, ms:number, timedOut:boolean, fresh:boolean}} CheckRun */

/** @param {number} n @param {string} one @param {string} [many] */
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** @param {unknown} e */
const msg = (e) => (e instanceof Error ? e.message : String(e));

/**
 * One cap, as a number, or undefined when the person gave none. A loop with no ceiling is
 * an unattended bill, so an unset cap is the default rather than none, and a cap outside
 * the limits is refused rather than clamped.
 * @param {unknown} v @param {number} max @param {'attempts'|'minutes'} what
 * @returns {number|undefined}
 */
function cap(v, max, what) {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > max) throw Object.assign(new Error(`A loop's max ${what} is a whole number from 1 to ${max}`), { status: 400 });
  return n;
}

/**
 * A loop's two caps, as given: what the person named, and otherwise what `base` already has -
 * for a new loop, the defaults. A cap outside the limits is refused whether it is being set
 * for the first time or retuned, so no loop can be handed a ceiling it cannot be held to.
 * @param {{max_attempts?:unknown, max_minutes?:unknown}|null|undefined} [o]
 * @param {{max_attempts:number, max_minutes:number}} [base]
 * @returns {{max_attempts:number, max_minutes:number}}
 */
function loopCaps(o, base = { max_attempts: MAX_ATTEMPTS, max_minutes: MAX_MINUTES }) {
  return {
    max_attempts: cap(o?.max_attempts, CAP_LIMITS.attempts, 'attempts') ?? base.max_attempts,
    max_minutes: cap(o?.max_minutes, CAP_LIMITS.minutes, 'minutes') ?? base.max_minutes,
  };
}

/**
 * A loop turned on, or one already running with its caps retuned. Turning a loop on again
 * after it ended starts a fresh one, at zero attempts; retuning one that is still going
 * keeps how far it has got, and a cap the person did not name keeps the value it had.
 * @param {{max_attempts?:unknown, max_minutes?:unknown}|null|undefined} o
 * @param {string|null} check the command the loop ends on; a loop without one never ends
 * @param {TaskLoop|null} [running] the loop already going, if any
 * @returns {TaskLoop}
 */
export function newLoop(o, check, running) {
  if (running) return { ...running, ...loopCaps(o, running) };
  if (!check) throw Object.assign(new Error('A loop needs a check to end it: this task has no check command. Set one first.'), { status: 400 });
  return { ...loopCaps(o), attempts: 0, state: 'looping', reason: null, started_at: new Date().toISOString(), ended_at: null, session_id: null };
}

/** How a loop that is over is named in the log and the transcript. @type {Record<TaskLoopState, string>} */
const ENDING = { looping: 'Loop', done: 'Loop done', 'gave-up': 'Loop gave up', stopped: 'Loop stopped', error: 'Loop stopped' };

/**
 * The overnight contract, kept: while a task's loop is on and its session goes idle, the
 * check decides what happens next. Passed ends the loop; failed sends the session back to
 * work with the output, up to its caps; a cap reached with the check still failing ends the
 * loop and asks the session once more, read-only, to write up why it is stuck.
 *
 * The Service owns one of these. It listens for `turn-done`, which the runtime emits when a
 * session has finished every message it was given and is idle again.
 */
export class Loop {
  /** @param {Service} svc */
  constructor(svc) {
    this.svc = svc;
    /** @type {Store} */
    this.store = svc.store;
    /** @type {Runtime} */
    this.runtime = svc.runtime;
    /** Sessions whose read-only write-up turn is in flight, by id. @type {Set<string>} */
    this.writeUps = new Set();
    /** Sessions whose turn-end is being decided right now, so one turn is handled once. @type {Set<string>} */
    this.deciding = new Set();
    this.runtime.on('turn-done', ({ session, ok }) => {
      if (session) void this.turnDone(session, ok).catch((e) => this.#itselfBroke(session, e));
    });
  }

  /** Something in the loop itself threw. That is not the model's problem to carry: end the
   * loop and say what happened, in both places the person looks. @param {Session} s @param {unknown} e */
  #itselfBroke(s, e) {
    const t = s.task_id ? this.store.getTask(s.task_id) : null;
    if (t?.loop?.state === 'looping') this.stop(t.id, 'error', 'the loop itself failed', msg(e));
  }

  // -- what a person does -------------------------------------------------------------

  /**
   * A person has just turned a task's loop on. It starts now if the session it feeds is
   * idle, and otherwise at the end of the turn already running.
   * @param {string} taskId
   */
  async start(taskId) {
    try {
      const t = this.store.getTask(taskId);
      const loop = t?.loop;
      if (!t || !loop || loop.state !== 'looping') return;
      const bound = loop.session_id ? this.store.getSession(loop.session_id) : null;
      const s = bound && !bound.archived_at ? bound : this.#newest(taskId);
      if (!s) return; // no session yet: the first one to finish a turn picks it up
      this.#mark(s, `Looping until \`${t.check_command}\` passes: up to ${plural(loop.max_attempts, 'attempt')} or ${plural(loop.max_minutes, 'minute')}. Only a person can start or stop a loop.`);
      if (s.status === 'running' || s.status === 'waiting' || this.runtime.busy(s.id)) return;
      await this.turnDone(this.store.getSession(s.id) || s, true);
    } catch (e) {
      this.stop(taskId, 'error', 'the loop itself failed', msg(e));
    }
  }

  /**
   * A person has turned the loop off, or its task was closed or merged, or its session was
   * archived or deleted. Nothing more is sent either way.
   * @param {string} taskId @param {string} why a phrase for the log, e.g. "it was turned off"
   */
  off(taskId, why = 'the person turned it off') {
    const stopped = this.stop(taskId, 'stopped', why);
    const sessionId = stopped?.loop?.session_id;
    if (sessionId) this.writeUps.delete(sessionId);
    return stopped;
  }

  /**
   * A loop's session is going away: there is nothing left to feed.
   * @param {Session} s @param {string} [why] a phrase for the log
   */
  sessionGone(s, why) {
    const t = s.task_id ? this.store.getTask(s.task_id) : null;
    const loop = t?.loop;
    // Either the session this loop has been feeding, or - before its first attempt - the one
    // it would have fed. Nothing else in the task is stored anywhere near it.
    const feeding = loop?.session_id ? loop.session_id === s.id : this.#newest(/** @type {string} */ (t?.id))?.id === s.id;
    if (t && loop?.state === 'looping' && feeding) this.stop(t.id, 'stopped', why || 'its session was archived');
    this.writeUps.delete(s.id);
  }

  /**
   * Ends a task's loop and says how and why, in the task's log and the session's transcript.
   * A loop that is not running is left as it is. @param {string} taskId
   * @param {TaskLoopState} state @param {string|null} reason a clause: "the check still fails after 10 attempts"
   * @param {string} [evidence] what was seen - the check's output, the error, the check's last word
   * @returns {Task|undefined}
   */
  stop(taskId, state, reason, evidence) {
    const t = this.store.getTask(taskId);
    const loop = t?.loop;
    if (!t || !loop || loop.state !== 'looping') return t;
    const ended = this.#write(t, loop, { state, reason, ended_at: new Date().toISOString() });
    // The write was dropped: something ended or replaced this loop first, and it has already
    // said so in the log. An ending nobody wrote is not worth a second, wrong one.
    if (ended?.loop?.state !== state || ended.loop.started_at !== loop.started_at) return ended;
    const s = loop.session_id ? this.store.getSession(loop.session_id) : null;
    const text = reason ? `${ENDING[state]}: ${reason}.` : `${ENDING[state]}: the check passed.`;
    this.store.addLog({ task_id: taskId, session_id: s?.id || null, kind: 'loop', decision: text.replace(/\.$/, ''), evidence: evidence || `${plural(loop.attempts, 'attempt')} sent; the check last ${t.check_status === 'running' ? 'was running' : t.check_status || 'was not run'}` });
    if (s && !s.archived_at) this.runtime.record(s.id, 'loop', { text });
    return ended;
  }

  // -- the loop itself ------------------------------------------------------------------

  /**
   * A session's turn ended, and it is idle: this is where the across-messages loop turns.
   * @param {Session} s @param {boolean} [ok] false when the turn ended as an error
   */
  async turnDone(s, ok = true) {
    if (this.deciding.has(s.id)) return;
    this.deciding.add(s.id);
    try {
      if (this.writeUps.has(s.id)) return this.#writeUpDone(s);
      let t = this.#looping(s);
      if (!t || !t.loop) return;
      // A session that errored, or whose turn ended as one, has nothing to carry on with.
      if (s.status === 'error' || !ok) {
        const why = s.error || (s.status === 'error' ? 'it could not go on' : 'its turn ended in an error');
        return this.stop(t.id, 'error', 'its session errored', `${why}\n\n${plural(t.loop.attempts, 'attempt')} were sent.`);
      }
      // A session waiting on the person is theirs until they answer: a message now would
      // sit behind the approval they have not answered.
      if (s.status === 'waiting' || this.runtime.pending(s.id).length) return;
      t = this.#bind(t, s);
      const r = await this.runtime.check(t.id);
      // The check takes seconds, and a person can turn the loop off - or change its caps -
      // inside them. What happens next belongs to the loop that is there when the check
      // answers, not to the one that asked for it.
      const loop = this.#current(t, /** @type {TaskLoop} */ (t.loop));
      if (!loop) return;
      if (!r) return this.stop(t.id, 'stopped', 'the check could not run', 'The worktree is gone, or the task no longer has a check.');
      if (r.ok) return this.stop(t.id, 'done', null, `\`${t.check_command}\` passed after ${plural(loop.attempts, 'attempt')}`);
      const reached = this.#cap(loop);
      if (reached) return await this.#giveUp(t, s, reached, loop, r);
      await this.#back(t, s, loop, r);
    } finally {
      this.deciding.delete(s.id);
    }
  }

  /** The task this session's loop is feeding, or null if there is no loop to feed. @param {Session} s */
  #looping(s) {
    if (!s.task_id || s.archived_at || s.purpose === 'review') return null;
    const t = this.store.getTask(s.task_id);
    const loop = t?.loop;
    if (!t || !loop || loop.state !== 'looping') return null;
    // Nobody loops a session whose task is done with: a merge or a close ends the loop.
    if (t.state !== 'active') {
      this.stop(t.id, 'stopped', `the task was ${t.state}`);
      return null;
    }
    return loop.session_id && loop.session_id !== s.id ? null : t;
  }

  /**
   * Ties the loop to the session it feeds, the first time one of the task's finishes a turn.
   * @param {Task} t @param {Session} s @returns {Task}
   */
  #bind(t, s) {
    const loop = /** @type {TaskLoop} */ (t.loop);
    if (loop.session_id === s.id) return t;
    return this.#write(t, loop, { session_id: s.id });
  }

  /** A cap this loop has reached, in words. Null while it has room for another attempt. @param {TaskLoop} loop */
  #cap(loop) {
    // The check has already had its say: a loop whose check passes at the cap is done, not stuck.
    if (loop.attempts >= loop.max_attempts) return `the check still fails after ${plural(loop.max_attempts, 'attempt')}`;
    const minutes = (Date.now() - Date.parse(loop.started_at)) / 60000;
    if (minutes >= loop.max_minutes) return `the check still fails after ${plural(loop.max_minutes, 'minute')}`;
    return null;
  }

  /**
   * Sends the session back to work with the check's failure. That is one attempt, counted
   * before it goes, so a send that fails to land cannot be repeated without end.
   * @param {Task} t @param {Session} s @param {TaskLoop} loop @param {CheckRun} r
   */
  async #back(t, s, loop, r) {
    const n = loop.attempts + 1;
    this.#write(t, loop, { attempts: n });
    const how = r.timedOut ? 'timed out' : `failed (exit ${r.code ?? '?'})`;
    const tail = this.#tail(r.output);
    const text = `The check still fails: \`${t.check_command}\` ${how}. The end of its output:\n\n${tail}\n\nKeep going. (Loop attempt ${n} of ${loop.max_attempts}.)`;
    try {
      this.svc.send(s.id, text);
    } catch (e) {
      return this.stop(t.id, 'stopped', `it could not be sent back to work: ${msg(e)}`);
    }
    this.#record(t, s, `Loop attempt ${n} of ${loop.max_attempts}: the check ${how}. Sent back to work.`, `\`${t.check_command}\` ${how}:\n\n${tail}`);
  }

  /**
   * A cap was reached with the check still failing. The loop ends here, and the session is
   * asked once more - in Plan mode, so that nothing more is changed - to write up why it is
   * stuck. The write-up goes into the task's log when that turn ends.
   * @param {Task} t @param {Session} s @param {string} why @param {TaskLoop} loop @param {CheckRun} r
   */
  async #giveUp(t, s, why, loop, r) {
    const how = r.timedOut ? 'timed out' : `failed (exit ${r.code ?? '?'})`;
    this.stop(t.id, 'gave-up', why, `\`${t.check_command}\` ${how} at attempt ${loop.attempts} of ${loop.max_attempts}:\n\n${this.#tail(r.output)}`);
    this.writeUps.add(s.id);
    try {
      await this.runtime.setMode(s.id, 'plan');
    } catch {
      /* a session that will not take the mode is still asked to write up */
    }
    // Turning it off while the mode was being set means no write-up: the person is there.
    const still = this.store.getTask(t.id)?.loop;
    if (!still || still.started_at !== loop.started_at || still.state !== 'gave-up') return this.writeUps.delete(s.id);
    try {
      this.svc.send(s.id, this.#brief(t, why), { writeUp: true });
      this.#mark(s, 'The loop is over. One more turn, read-only, to write up why it is stuck.');
    } catch (e) {
      this.writeUps.delete(s.id);
      this.#mark(s, `The loop ended, but the write-up could not be asked for: ${msg(e)}`);
    }
  }

  /**
   * The write-up turn ended. What the session said about being stuck goes into the task's
   * log, where the person reads it in the morning.
   * @param {Session} s
   */
  #writeUpDone(s) {
    this.writeUps.delete(s.id);
    const t = s.task_id ? this.store.getTask(s.task_id) : null;
    const reply = this.#lastReply(s.id);
    this.runtime.record(s.id, 'loop', { text: 'Write-up recorded in the task log.' });
    if (!t) return;
    this.store.addLog({ task_id: t.id, session_id: s.id, kind: 'loop', decision: `Why it is stuck, in its own words (loop ended: ${t.loop?.reason || 'the check never passed'})`, evidence: reply || '(the session wrote nothing up)' });
    this.runtime.emit('task', this.store.updateTask(t.id, {}));
  }

  /**
   * One loop event, in both places a person looks: the session's transcript, and the task's log.
   * @param {Task} t @param {Session} s @param {string} text @param {string} evidence
   */
  #record(t, s, text, evidence) {
    this.#mark(s, text);
    this.store.addLog({ task_id: t.id, session_id: s.id, kind: 'loop', decision: text, evidence });
    this.runtime.emit('task', this.store.updateTask(t.id, {}));
  }

  /** @param {Session} s @param {string} text */
  #mark(s, text) {
    this.runtime.record(s.id, 'loop', { text });
  }

  /**
   * The loop is still the one the caller was looking at: not turned off, not restarted into a
   * fresh one, and not already ended. `started_at` is what tells two loops of one task apart.
   * It comes back from the store, so a person's change to the caps while a check was running
   * is part of what is returned. Null when the loop is no longer there to act on.
   * @param {Task} t @param {TaskLoop} loop
   * @returns {TaskLoop|null}
   */
  #current(t, loop) {
    const now = this.store.getTask(t.id)?.loop;
    return now && now.started_at === loop.started_at && now.state === 'looping' ? now : null;
  }

  /**
   * Writes a change to a loop. A change decided before a person turned the loop off, or gave
   * the task a different one, is dropped: an unattended loop must not turn itself back on, and
   * must not write back the caps the person has since changed. `patch` is only the fields the
   * caller means to set; they are laid over the loop as it is now.
   * @param {Task} t @param {TaskLoop} loop @param {Partial<TaskLoop>} patch @returns {Task}
   */
  #write(t, loop, patch) {
    const now = this.#current(t, loop);
    if (!now) return /** @type {Task} */ (this.store.getTask(t.id));
    const updated = this.store.updateTask(t.id, { loop: { ...now, ...patch } });
    this.runtime.emit('task', updated);
    return updated;
  }

  /** The task's newest session that is not a reviewer's and still there; the one a loop feeds. @param {string} taskId */
  #newest(taskId) {
    return this.store.listSessions({ taskId }).find((s) => s.purpose !== 'review' && !s.archived_at) || null;
  }

  /** The end of a check's output, which is where the failure is. @param {string|null} output */
  #tail(output) {
    const text = String(output || '').trimEnd() || '(no output)';
    return text.length > OUTPUT_CHARS ? `… (earlier output cut)\n${text.slice(-OUTPUT_CHARS)}` : text;
  }

  /** The last thing a session said, from its transcript. @param {string} id */
  #lastReply(id) {
    for (const e of this.store.listEvents(id, { limit: 200 }).reverse()) {
      if (e.kind !== 'assistant' || e.data?.parent) continue;
      const text = (e.data?.content || []).filter((/** @type {any} */ b) => b.type === 'text').map((/** @type {any} */ b) => b.text).join('\n').trim();
      if (text) return text;
    }
    return null;
  }

  /** One last turn, read-only: what it tried, what is failing, what it needs. @param {Task} t @param {string} why */
  #brief(t, why) {
    return [
      `The loop on this task has ended: ${why}. The work is not finished, and nothing more will be sent.`,
      `The check is \`${t.check_command}\`, run in this worktree.`,
      t.done ? `Done means: ${t.done}` : null,
      'You are in Plan mode, and this is the last turn: change nothing, and do not call ExitPlanMode. Write up where you are stuck, so the person can pick it up when they read it - what you tried and what each attempt showed, what the failure is now, and what you need to finish (a decision, a key, a file, something outside this task).',
      'Reply with that write-up as plain text.',
    ]
      .filter(Boolean)
      .join('\n\n');
  }
}
