// A task: its sessions, what it changed against its base, a shell in its worktree, and
// the way back into the base branch.
import { html, useEffect, useRef, useState } from '../lib.mjs';
import { api, useStore } from '../api.mjs';
import { showToast } from '../components/toast.mjs';
import { DiffViewer } from '../components/diff-viewer.mjs';
import { MoreMenu } from '../components/menu.mjs';
import { TerminalPane } from '../components/terminal.mjs';
import { Dialog, Dot, TaskBadge, Sheet, Icon } from '../components/ui.mjs';
import { SessionPane } from './session.mjs';
import { CommitDialog, go } from './project.mjs';

const toast = (e) => showToast(e.message || String(e), 'error');

function useTaskGit(task) {
  const tick = useStore((s) => s.gitTick[task?.project_id] || 0);
  const sessionsBusy = useStore((s) => s.sessions.filter((x) => x.task_id === task?.id && x.status === 'running').length);
  const [git, setGit] = useState(null);
  const load = () => task && api.taskGit(task.id).then(setGit).catch(() => {});
  useEffect(() => {
    load();
  }, [task?.id, task?.state, task?.updated_at, tick, sessionsBusy]);
  return { git, reload: load };
}

export function TaskView({ projectId, taskId, sessionId, tab }) {
  const task = useStore((s) => s.tasks.find((t) => t.id === taskId));
  const all = useStore((s) => s.sessions);
  const [archived, setArchived] = useState([]);
  const { git, reload } = useTaskGit(task);
  const [dialog, setDialog] = useState(null);
  const [ship, setShip] = useState(false);
  const swipe = useRef(null);

  // Archived sessions are not in the live list; a merged task's are all archived.
  useEffect(() => {
    api.task(taskId).then((r) => setArchived(r.sessions.filter((s) => s.archived_at))).catch(() => {});
  }, [taskId, task?.state]);

  if (!task) return html`<div class="page muted">No such task.</div>`;
  const sessions = [...all.filter((s) => s.task_id === taskId), ...archived.filter((a) => !all.some((s) => s.id === a.id))];
  const current = tab ? null : sessions.find((s) => s.id === sessionId) || sessions[0];
  const base = `#/p/${projectId}/t/${taskId}`;
  const active = task.state === 'active';

  const newSession = async () => {
    try {
      const s = await api.createSession({ projectId, taskId });
      go(`${base}/s/${s.id}`);
    } catch (e) {
      toast(e);
    }
  };

  const act = async (fn, done) => {
    try {
      const r = await fn();
      if (done) showToast(done, 'success');
      reload();
      return r;
    } catch (e) {
      toast(e);
    }
  };

  const rename = () => {
    const title = prompt('Rename task', task.title);
    if (title?.trim() && title !== task.title) api.renameTask(taskId, title).catch(toast);
  };

  return html`
    <div class="task-view">
      <header class="task-head">
        <div class="task-title-row">
          <button class="title-btn h1" type="button" onClick=${rename} title="Rename">${task.title}</button>
          <${TaskBadge} state=${task.state} />
        </div>
        <div class="task-meta">
          <code class="mono-sm">${task.branch}</code><span class="muted"> → </span><code class="mono-sm">${task.base_branch}</code>
          ${git
            ? html`<span class="muted git-counts">
                ${git.ahead ? html` · ${git.ahead} commit${git.ahead === 1 ? '' : 's'}` : ''}${git.dirty.length ? html` · ${git.dirty.length} uncommitted` : ''}${git.files ? html` · <span class="good">+${git.added}</span> <span class="bad">−${git.removed}</span>` : ''}${git.behind ? html` · ${git.behind} behind ${task.base_branch}` : ''}
              </span>`
            : null}
        </div>
        <div class="task-actions">
          ${active
            ? html`
                <span class="hide-narrow task-actions-wide">
                  ${git?.behind ? html`<button class="btn sm secondary" type="button" onClick=${() => act(() => api.updateTask(taskId), null).then((r) => r && (r.conflicts?.length ? (showToast('Conflicts to resolve: see Changes', 'error'), go(`${base}/changes`)) : showToast(`Merged ${task.base_branch} in`, 'success')))}>Update from ${task.base_branch}</button>` : null}
                  <button class="btn sm" type="button" disabled=${!git?.canMerge?.ok} title=${git?.canMerge?.reason || ''} onClick=${() => setDialog('merge')}>Merge into ${task.base_branch}</button>
                </span>
                <button class="btn sm only-phone" type="button" onClick=${() => setShip(true)}>Ship…</button>
              `
            : task.state === 'closed'
              ? html`<button class="btn sm secondary" type="button" onClick=${() => act(() => api.reopenTask(taskId), 'Reopened')}>Reopen</button>`
              : null}
          <${MoreMenu}
            items=${active
              ? [
                  git?.dirty?.length ? { label: 'Commit…', onSelect: () => setDialog('commit') } : null,
                  { label: 'Push branch', onSelect: () => act(() => api.pushTask(taskId), 'Pushed') },
                  { label: 'Open a pull request…', onSelect: () => setDialog('pr') },
                  { label: 'Close task…', danger: true, onSelect: () => setDialog('close') },
                ]
              : [{ label: 'Back to project', onSelect: () => go(`#/p/${projectId}`) }]}
          />
        </div>
      </header>

      ${active || task.check_command || task.done ? html`<${TaskBar} task=${task} active=${active} onEdit=${() => setDialog('bar')} onOutput=${() => setDialog('output')} onLoop=${() => setDialog('loop')} />` : null}

      <nav class="task-tabs" role="tablist">
        ${sessions.map(
          (s) => html`<a role="tab" class="task-tab ${current?.id === s.id ? 'active' : ''} ${s.archived_at ? 'archived' : ''}" href=${`${base}/s/${s.id}`} key=${s.id}><${Dot} status=${s.status} /><span>${s.title}</span></a>`
        )}
        ${active ? html`<button class="task-tab add" type="button" onClick=${newSession} aria-label="New session in this task"><${Icon} name="plus" /></button>` : null}
        <span class="tab-gap"></span>
        <a role="tab" class="task-tab ${tab === 'changes' ? 'active' : ''}" href=${`${base}/changes`}>Changes${git?.files ? html` <span class="count">${git.files}</span>` : ''}${git?.conflicted?.length ? html` <span class="badge badge-bad">!</span>` : ''}</a>
        <a role="tab" class="task-tab ${tab === 'log' ? 'active' : ''}" href=${`${base}/log`}>Log</a>
        ${active ? html`<a role="tab" class="task-tab ${tab === 'terminal' ? 'active' : ''}" href=${`${base}/terminal`}><${Icon} name="terminal" /> Terminal</a>` : null}
      </nav>

      <div
        class="task-body"
        onTouchStart=${(e) => {
          const t = e.touches[0];
          swipe.current = { x: t.clientX, y: t.clientY };
        }}
        onTouchEnd=${(e) => {
          const from = swipe.current;
          swipe.current = null;
          // A swipe moves between a task's sessions, the way the tab strip does with a
          // thumb. It must not fire on a vertical scroll, on a field being edited, or on
          // the Changes or Terminal pane, which are not sessions.
          if (!from || tab || !current) return;
          const tag = e.target?.tagName;
          if (tag === 'INPUT' || tag === 'TEXTAREA') return;
          const t = e.changedTouches[0];
          const dx = t.clientX - from.x;
          const dy = t.clientY - from.y;
          if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.6) return;
          const i = sessions.findIndex((s) => s.id === current.id);
          const j = dx < 0 ? i + 1 : i - 1;
          if (j >= 0 && j < sessions.length) go(`${base}/s/${sessions[j].id}`);
        }}
      >
        ${tab === 'changes'
          ? html`<${Changes} task=${task} git=${git} sessions=${sessions} reload=${reload} />`
          : tab === 'log'
            ? html`<${DecisionLog} task=${task} sessions=${sessions} />`
          : tab === 'terminal'
            ? html`<div class="terminal-page"><${TerminalPane} query=${{ task: taskId }} /></div>`
            : current
              ? html`<${SessionPane} key=${current.id} sessionId=${current.id} onArchived=${() => go(base)} />`
              : html`<div class="pane-empty"><p class="muted">No sessions in this task.</p>${active ? html`<button class="btn" type="button" onClick=${newSession}>Start a session</button>` : null}</div>`}
      </div>

      ${ship
        ? html`<${ShipSheet}
            task=${task}
            git=${git}
            onClose=${() => setShip(false)}
            onMerge=${() => {
              setShip(false);
              setDialog('merge');
            }}
            onPr=${() => {
              setShip(false);
              setDialog('pr');
            }}
            onCommit=${(m) => api.commitTask(taskId, m).then(reload)}
          />`
        : null}
      ${dialog === 'merge' ? html`<${MergeDialog} task=${task} git=${git} onClose=${() => setDialog(null)} />` : null}
      ${dialog === 'commit' ? html`<${CommitDialog} title="Commit in the task" initial=${task.title} files=${git?.dirty || []} onClose=${() => setDialog(null)} onCommit=${(m) => api.commitTask(taskId, m).then(reload)} />` : null}
      ${dialog === 'pr' ? html`<${PrDialog} task=${task} onClose=${() => setDialog(null)} />` : null}
      ${dialog === 'close' ? html`<${CloseDialog} task=${task} onClose=${() => setDialog(null)} />` : null}
      ${dialog === 'bar' ? html`<${BarDialog} task=${task} onClose=${() => setDialog(null)} />` : null}
      ${dialog === 'loop' ? html`<${LoopDialog} task=${task} onClose=${() => setDialog(null)} />` : null}
      ${dialog === 'output' ? html`<${Dialog} wide title=${`Last check: ${task.check_command}`} onClose=${() => setDialog(null)}><pre class="check-output">${task.check_output || '(no output)'}</pre><//>` : null}
    </div>
  `;
}

/**
 * Everything that lands a task, in one place a thumb can reach. On a phone the header
 * cannot hold Commit, Push and Merge as three buttons; this is the one button, and the
 * sheet it opens is the same actions with room for the commit message and the counts.
 */
function ShipSheet({ task, git, onClose, onMerge, onPr, onCommit }) {
  const [message, setMessage] = useState(task.title);
  const [busy, setBusy] = useState(false);
  const dirty = git?.dirty || [];
  const commit = async () => {
    setBusy(true);
    try {
      await onCommit(message.trim() || task.title);
      showToast('Committed', 'success');
      onClose();
    } catch (e) {
      setBusy(false);
      toast(e);
    }
  };
  return html`
    <${Sheet} title="Ship this task" onClose=${onClose}>
      ${dirty.length
        ? html`<div class="field">
            <span class="field-label">Commit message · ${dirty.length} file${dirty.length === 1 ? '' : 's'}</span>
            <textarea class="input" rows="2" placeholder="Commit message" value=${message} onInput=${(e) => setMessage(e.target.value)}></textarea>
            <div class="file-list mono-sm">${dirty.slice(0, 8).map((f) => html`<div>${f}</div>`)}${dirty.length > 8 ? html`<div class="muted">and ${dirty.length - 8} more</div>` : null}</div>
          </div>
          <button class="btn" type="button" disabled=${busy || !message.trim()} onClick=${commit}>Commit</button>`
        : html`<p class="muted">Nothing uncommitted. ${git?.ahead ? `${git.ahead} commit${git.ahead === 1 ? '' : 's'} ready to land.` : 'No commits ahead of ' + task.base_branch + ' yet.'}</p>`}
      <div class="sheet-actions">
        <button class="btn secondary" type="button" onClick=${async () => { onClose(); await api.pushTask(task.id).then(() => showToast('Pushed', 'success')).catch(toast); }}>Push branch</button>
        <button class="btn secondary" type="button" disabled=${!git?.canMerge?.ok} title=${git?.canMerge?.reason || ''} onClick=${onMerge}>Merge into ${task.base_branch}</button>
        <button class="btn secondary" type="button" onClick=${onPr}>Open a pull request…</button>
        <button class="btn ghost" type="button" onClick=${() => { onClose(); go(`#/p/${task.project_id}/t/${task.id}/changes`); }}>View the changes</button>
      </div>
    <//>
  `;
}

function Changes({ task, git, sessions, reload }) {
  const tick = useStore((s) => s.gitTick[task.project_id] || 0);
  const [diff, setDiff] = useState(null);
  useEffect(() => {
    api.taskDiff(task.id).then((r) => setDiff(r.diff)).catch(toast);
  }, [task.id, tick, git?.files, git?.added, git?.removed, git?.dirty?.length]);

  const resolve = async () => {
    const s = sessions.find((x) => !x.archived_at);
    if (!s) return toast(new Error('Start a session first'));
    await api.send(s.id, `Merging ${task.base_branch} into this branch left conflicts in: ${git.conflicted.join(', ')}. Resolve them, keeping both sides' intent, then commit the merge.`).catch(toast);
    go(`#/p/${task.project_id}/t/${task.id}/s/${s.id}`);
  };

  return html`
    <div class="changes">
      ${git?.conflicted?.length
        ? html`<div class="notice notice-warn">
            <div><strong>Merge conflicts</strong> in ${git.conflicted.map((f) => html`<code>${f}</code> `)}</div>
            <div class="row">
              <button class="btn sm" type="button" onClick=${resolve}>Ask Claude to resolve them</button>
              <button class="btn sm secondary" type="button" onClick=${() => api.abortMerge(task.id).then(reload).catch(toast)}>Abort the merge</button>
            </div>
          </div>`
        : null}
      ${git && !git.canMerge.ok && git.canMerge.conflicts.length && !git.conflicted.length
        ? html`<div class="notice notice-warn">
            Merging now would conflict with <code>${task.base_branch}</code> in ${git.canMerge.conflicts.map((f) => html`<code>${f}</code> `)}.
            Update from ${task.base_branch} to resolve them here first.
          </div>`
        : null}
      ${diff === null ? html`<div class="muted">Loading…</div>` : diff ? html`<${DiffViewer} diff=${diff} nav storageKey=${`bench:viewed:${task.id}`} />` : html`<div class="muted pane-empty">No changes against ${task.base_branch} yet.</div>`}
    </div>
  `;
}

/**
 * The task's decision log, newest first: what its sessions decided, and the evidence
 * they gave, written with the bench tool `log`. A new entry touches the task, which is
 * what reloads this.
 */
function DecisionLog({ task, sessions }) {
  const [log, setLog] = useState(null);
  useEffect(() => {
    api.taskLog(task.id).then(setLog).catch(toast);
  }, [task.id, task.updated_at]);
  if (log === null) return html`<div class="muted pane-empty">Loading…</div>`;
  if (!log.length) return html`<div class="muted pane-empty">No decisions logged yet. Sessions add them with the <code>log</code> tool, each with the evidence behind it. A loop writes here too: every attempt, and why it ended.</div>`;
  const titled = (id) => sessions.find((s) => s.id === id)?.title || (id ? id.slice(0, 8) : '');
  return html`
    <ol class="decision-log">
      ${log.map(
        (e) => html`<li key=${e.id} class="decision ${e.kind === 'loop' ? 'loop' : ''}">
          ${e.kind === 'loop' ? html`<span class="badge badge-info">Loop</span>` : null}
          <div class="decision-text">${e.decision}</div>
          <div class="decision-evidence"><span class="muted">Evidence:</span> ${e.evidence}</div>
          <div class="muted mono-sm">${new Date(e.created_at).toLocaleString()}${e.session_id ? html` · <a href=${`#/p/${task.project_id}/t/${task.id}/s/${e.session_id}`}>${titled(e.session_id)}</a>` : null}</div>
        </li>`
      )}
    </ol>
  `;
}

function MergeDialog({ task, git, onClose }) {
  const [strategy, setStrategy] = useState('merge');
  const [message, setMessage] = useState('');
  const [cleanup, setCleanup] = useState(true);
  const [busy, setBusy] = useState(false);
  const merge = async () => {
    setBusy(true);
    try {
      const r = await api.mergeTask(task.id, { strategy, message, cleanup });
      showToast(`Merged into ${task.base_branch}${r.fastForward ? ' (fast-forward)' : ''}`, 'success');
      onClose();
    } catch (e) {
      toast(e);
      setBusy(false);
    }
  };
  return html`
    <${Dialog}
      title=${`Merge into ${task.base_branch}`}
      onClose=${onClose}
      actions=${html`<button class="btn ghost" type="button" onClick=${onClose}>Cancel</button><button class="btn primary" type="button" disabled=${busy} onClick=${merge}>${busy ? 'Merging…' : 'Merge'}</button>`}
    >
      ${git?.dirty?.length ? html`<p class="muted">${git.dirty.length} uncommitted file${git.dirty.length === 1 ? ' is' : 's are'} committed first, as "${task.title}".</p>` : null}
      <div class="choices">
        <button type="button" class="choice ${strategy === 'merge' ? 'picked' : ''}" onClick=${() => setStrategy('merge')}><strong>Merge</strong><span class="muted">Keep the task's commits${git?.ahead ? ` (${git.ahead})` : ''}; fast-forward when possible</span></button>
        <button type="button" class="choice ${strategy === 'squash' ? 'picked' : ''}" onClick=${() => setStrategy('squash')}><strong>Squash</strong><span class="muted">One commit on ${task.base_branch}</span></button>
      </div>
      <input class="input" placeholder=${strategy === 'squash' ? task.title : `Merge task: ${task.title}`} value=${message} onInput=${(e) => setMessage(e.target.value)} />
      <label class="check"><input type="checkbox" checked=${cleanup} onChange=${(e) => setCleanup(e.target.checked)} /> Remove the worktree and branch afterwards</label>
      <p class="muted">If ${task.base_branch} is checked out, the merge happens in that checkout, and git refuses if it would overwrite uncommitted changes there.</p>
    <//>
  `;
}

function PrDialog({ task, onClose }) {
  const [title, setTitle] = useState(task.title);
  const [body, setBody] = useState(task.description || '');
  const [busy, setBusy] = useState(false);
  const open = async () => {
    setBusy(true);
    try {
      const r = await api.pullRequest(task.id, { title, body });
      showToast('Pull request opened', 'success');
      window.open(r.url, '_blank', 'noopener');
      onClose();
    } catch (e) {
      toast(e);
      setBusy(false);
    }
  };
  return html`
    <${Dialog}
      title=${`Pull request into ${task.base_branch}`}
      onClose=${onClose}
      actions=${html`<button class="btn ghost" type="button" onClick=${onClose}>Cancel</button><button class="btn primary" type="button" disabled=${busy || !title.trim()} onClick=${open}>${busy ? 'Opening…' : 'Push and open'}</button>`}
    >
      <input class="input" value=${title} onInput=${(e) => setTitle(e.target.value)} />
      <textarea class="input" rows="6" placeholder="Description" value=${body} onInput=${(e) => setBody(e.target.value)} />
      <p class="muted">Uses the GitHub CLI on the server. Uncommitted work is committed first.</p>
    <//>
  `;
}

function CloseDialog({ task, onClose }) {
  const [deleteBranch, setDeleteBranch] = useState(false);
  const close = async () => {
    try {
      await api.closeTask(task.id, { deleteBranch });
      onClose();
      go(`#/p/${task.project_id}`);
    } catch (e) {
      toast(e);
    }
  };
  return html`
    <${Dialog}
      title="Close this task?"
      onClose=${onClose}
      actions=${html`<button class="btn ghost" type="button" onClick=${onClose}>Cancel</button><button class="btn danger" type="button" onClick=${close}>Close task</button>`}
    >
      <p class="muted">The worktree is removed and its sessions archived. Uncommitted work in it is lost.</p>
      <label class="check"><input type="checkbox" checked=${deleteBranch} onChange=${(e) => setDeleteBranch(e.target.checked)} /> Also delete <code>${task.branch}</code> (it cannot be reopened then)</label>
    <//>
  `;
}

const CHECK_STATE = { passed: ['Check passed', 'badge-good'], failed: ['Check failed', 'badge-bad'], running: ['Checking…', 'badge-info'] };

/**
 * The task's bar for done, under its title: what done means, the command that checks it,
 * and how the last run went. A session that stops is checked against it by the server;
 * Run check is for a person who wants to see it now.
 */
/** The loop, in the bar: on and how far it has got, or how it ended and why. @param {any} task */
function LoopBadge({ task }) {
  const l = task.loop;
  const word = l.state === 'looping' ? `Looping · ${l.attempts} of ${l.max_attempts}` : l.state === 'done' ? 'Loop done' : l.state === 'gave-up' ? 'Loop gave up' : 'Loop stopped';
  const cls = l.state === 'looping' ? 'badge-info badge-working' : l.state === 'done' ? 'badge-good' : l.state === 'gave-up' ? 'badge-bad' : 'badge-neutral';
  const title =
    l.state === 'looping'
      ? `Bench runs ${task.check_command} whenever this task's session goes idle. A failure sends it back to work, up to ${l.max_attempts} attempts or ${l.max_minutes} minutes, and then it writes up why it is stuck. Click to stop.`
      : `Loop ${l.state === 'done' ? 'ended: the check passed' : l.reason || 'stopped'}. Click for the log.`;
  if (l.state === 'looping') {
    return html`<button class="badge ${cls} badge-btn" type="button" title=${title} onClick=${() => api.setTaskLoop(task.id, null).then(() => showToast('Loop stopped', 'success')).catch(toast)}>${word}</button>`;
  }
  return html`<a class="badge ${cls} badge-btn" href=${`#/p/${task.project_id}/t/${task.id}/log`} title=${title}>${word}</a>`;
}

function TaskBar({ task, active, onEdit, onOutput, onLoop }) {
  const [busy, setBusy] = useState(false);
  if (!task.check_command && !task.done) {
    return html`<div class="task-bar"><button class="btn sm ghost" type="button" onClick=${onEdit}>Say what done means…</button></div>`;
  }
  const [label, cls] = CHECK_STATE[task.check_status] || ['Not run yet', 'badge-neutral'];
  const run = async () => {
    setBusy(true);
    try {
      const t = await api.checkTask(task.id);
      showToast(t.check_status === 'passed' ? 'Check passed' : 'Check failed', t.check_status === 'passed' ? 'success' : 'error');
    } catch (e) {
      toast(e);
    } finally {
      setBusy(false);
    }
  };
  return html`
    <div class="task-bar">
      ${task.check_command
        ? html`<button class="badge ${cls} badge-btn" type="button" disabled=${!task.check_output} onClick=${onOutput} title=${task.check_at ? `Ran ${new Date(task.check_at).toLocaleString()}; show the output` : ''}>${label}</button>
            <code class="mono-sm task-bar-cmd" title=${task.check_command}>${task.check_command}</code>`
        : null}
      ${task.done ? html`<span class="task-bar-done" title=${task.done}><span class="muted">Done means:</span> ${task.done}</span>` : null}
      ${task.loop ? html`<${LoopBadge} task=${task} />` : null}
      <span class="tab-gap"></span>
      ${active && task.check_command && task.loop?.state !== 'looping' ? html`<button class="btn sm secondary" type="button" onClick=${onLoop} title="Keep going until the check passes, on its own">Loop until done…</button>` : null}
      ${active && task.check_command ? html`<button class="btn sm secondary" type="button" disabled=${busy || task.check_status === 'running'} onClick=${run}>${busy || task.check_status === 'running' ? 'Checking…' : 'Run check'}</button>` : null}
      ${active ? html`<button class="btn sm ghost" type="button" onClick=${onEdit}>Edit</button>` : null}
    </div>
  `;
}

/**
 * Turning the loop on: the two caps, and nothing else. A loop has no ceiling of its own, so
 * both are asked for; a task with no check cannot loop at all, and says so.
 */
function LoopDialog({ task, onClose }) {
  const [attempts, setAttempts] = useState(String(task.loop?.max_attempts ?? 10));
  const [minutes, setMinutes] = useState(String(task.loop?.max_minutes ?? 120));
  const [busy, setBusy] = useState(false);
  const whole = (v) => Number.isInteger(Number(v)) && Number(v) >= 1 && String(v).trim() !== '';
  const ok = whole(attempts) && whole(minutes);
  const start = async () => {
    setBusy(true);
    try {
      await api.setTaskLoop(task.id, { max_attempts: Number(attempts), max_minutes: Number(minutes) });
      showToast('Looping until the check passes', 'success');
      onClose();
    } catch (e) {
      toast(e);
      setBusy(false);
    }
  };
  return html`
    <${Dialog}
      title="Loop until done"
      onClose=${onClose}
      actions=${html`<button class="btn ghost" type="button" onClick=${onClose}>Cancel</button><button class="btn primary" type="button" disabled=${busy || !ok} onClick=${start}>${busy ? 'Starting…' : 'Start looping'}</button>`}
    >
      ${task.check_command
        ? html`<p class="muted">Bench runs <code>${task.check_command}</code> in the worktree whenever this task's session goes idle. A failure is sent straight back to the session, with the output, so it keeps working without you. It stops when the check passes, or at one of these limits — and then it asks the session to write up why it is stuck.</p>`
        : html`<p class="notice notice-bad">This task has no check command, so there is nothing to tell a loop when it is done. Set one under Edit first.</p>`}
      <div class="loop-caps">
        <label class="field"><span class="field-label">Most attempts</span><input class="input" type="number" min="1" max="100" value=${attempts} onInput=${(e) => setAttempts(e.target.value)} /></label>
        <label class="field"><span class="field-label">Most minutes</span><input class="input" type="number" min="1" max="1440" value=${minutes} onInput=${(e) => setMinutes(e.target.value)} /></label>
      </div>
      <p class="muted">Only you can start, retune or stop a loop; a session cannot put itself into one. You can stop it here or with <code>bench task loop ${task.id.slice(0, 8)} --off</code>.</p>
    <//>
  `;
}

function BarDialog({ task, onClose }) {
  const [done, setDone] = useState(task.done || '');
  const [check, setCheck] = useState(task.check_command || '');
  const save = async () => {
    try {
      await api.setTaskBar(task.id, { done, check });
      onClose();
    } catch (e) {
      toast(e);
    }
  };
  return html`
    <${Dialog}
      title="What done means"
      onClose=${onClose}
      actions=${html`<button class="btn ghost" type="button" onClick=${onClose}>Cancel</button><button class="btn primary" type="button" onClick=${save}>Save</button>`}
    >
      <label class="field"><span class="field-label">Done means</span><textarea class="input" rows="3" placeholder="e.g. the CSV export keeps every row of the 60k fixture" value=${done} onInput=${(e) => setDone(e.target.value)} /></label>
      <label class="field"><span class="field-label">Check command</span><input class="input mono-sm" placeholder="e.g. npm test" value=${check} onInput=${(e) => setCheck(e.target.value)} /></label>
      <p class="muted">Bench runs the check in the worktree whenever a session stops with changed files. A failure sends the session back to work, up to three times per message. Idle sessions pick up the change when they resume.</p>
    <//>
  `;
}
