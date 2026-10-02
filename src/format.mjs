// One activity row, from one raw event.
//
// The CLI, the TUI and the dashboard all render the same agent events, and they all
// render them through this file. A raw stream-json event is often a hundred fields
// wide with the one interesting field nested three levels down, and the stored
// `type` names the envelope rather than the contents: a tool call, a paragraph of
// prose, a reasoning trace and a subagent heartbeat are all stored as `message`.
// Rendering that type is how a feed fills with rows that say "message" and nothing
// else.
//
// So every reader below lifts the single fact a row needs, and `describeEvent`
// returns `{ kind, text }` or `null`. The kind is the badge — a word to scan for.
// Null means the event genuinely has nothing to say, and showing no row is better
// than showing one that says `system`.

const CAP = 160;

// The first non-blank line, shortened. Payloads open with blank lines and run to
// kilobytes; the opening line is the part a reader scans.
function firstLine(text, cap = CAP) {
  const line =
    String(text ?? '')
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) || '';
  return line.length > cap ? `${line.slice(0, cap - 1)}…` : line;
}

function isText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

// Assistant messages and tool results both carry a `content` array; a system notice
// carries no message at all. This cannot assume either shape.
function contentBlocks(data) {
  const content = (data?.message || data)?.content;
  return Array.isArray(content) ? content : [];
}

// What a tool call was pointed at. The interesting argument differs per tool — Bash
// takes a command, Read a file path, Grep a pattern, Agent a description — so the
// shapes worth naming are named, and anything else falls back to its first string
// argument. Without that fallback a tool row is a bare tool name, which is half of
// what the row could have said.
function toolTarget(input) {
  if (!input || typeof input !== 'object') return '';
  if (input.file_path) return String(input.file_path);
  if (input.command) return firstLine(input.command, 100);
  if (input.pattern) return String(input.pattern);
  if (input.path) return String(input.path);
  if (input.description) return firstLine(input.description, 90);
  if (input.summary) return firstLine(input.summary, 90);
  if (input.prompt) return firstLine(input.prompt, 90);
  if (input.query) return firstLine(input.query, 90);
  if (input.url) return String(input.url);
  const first = Object.values(input).find(isText);
  return first ? firstLine(first, 90) : '';
}

// A tool's output, reduced to its opening line plus how much more there is. The
// count is the part that matters: "4 lines" and "400 lines" say very different
// things about whether the agent has read enough to answer. A failed call is not
// output at all — it is the reason the agent changed course, so it gets its own kind
// and sheds the wrapper claude puts around the message.
function toolOutput(block) {
  const raw =
    typeof block?.content === 'string'
      ? block.content
      : Array.isArray(block?.content)
        ? block.content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('\n')
        : '';
  const text = raw.trim();
  if (!text) return { kind: 'out', text: 'no output' };
  const lines = text.split('\n').filter((l) => l.trim()).length;
  const head = firstLine(text.replace(/<\/?tool_use_error>/g, ''), 120);
  if (block?.is_error) return { kind: 'error', text: head };
  return { kind: 'out', text: lines > 1 ? `${head} (+${lines - 1} more lines)` : head };
}

// The final result frame. Its `result` field holds the run's closing message, which
// for a planner is the plan, so the metadata rides along rather than replacing it.
// A reviewer's answer is a structured verdict instead, and its prose is read from
// there.
function describeResult(data) {
  const ms = Number.isFinite(data.duration_ms)
    ? data.duration_ms
    : Number.isFinite(data.duration_api_ms)
      ? data.duration_api_ms
      : null;
  // A failed run still reports subtype `success` when the harness itself worked, so
  // the subtype is not what to lead with: `failed` is.
  const meta = [
    data.is_error ? 'failed' : data.subtype,
    data.num_turns ? `${data.num_turns} turn${data.num_turns === 1 ? '' : 's'}` : '',
    ms != null ? formatDuration(ms) : '',
    data.total_cost_usd != null ? formatCost(data.total_cost_usd) : '',
  ]
    .filter(Boolean)
    .join(' · ');
  // A reviewer's closing frame carries its answer twice over: `result` is the JSON
  // envelope that --json-schema produces, and the words a person wants are in
  // `structured_output.review`. Preferring the field is what keeps a truncated
  // `{"verdict":"PASS",…` off the activity feed.
  const said = isText(data.structured_output?.review) ? data.structured_output.review : data.result;
  const body = isText(said) ? firstLine(said, 140) : '';
  const kind = data.is_error ? 'error' : 'done';
  if (!body) return { kind, text: meta || 'result' };
  return { kind, text: meta ? `${meta} — ${body}` : body };
}

// Claude Code reports its own quota state here. "allowed" on its own says nothing;
// the utilisation and the reset time are what tell you whether a run is about to
// start failing.
function describeRateLimit(data) {
  const info = data.rate_limit_info || {};
  const window = info.unifiedWindows?.five_hour;
  const used = window?.utilization != null ? `${Math.round(window.utilization * 100)}% of 5h used` : '';
  // The harness emits one of these per turn, and almost every one of them says the
  // same thing: the quota is fine. Only a refusal is news, and it is the kind of news
  // that explains a run about to fail, so it is the only form that carries weight.
  const blocking = isText(info.status) && info.status !== 'allowed';
  if (blocking) {
    const parts = [info.status, isText(info.overageDisabledReason) ? info.overageDisabledReason.replace(/_/g, ' ') : ''];
    if (window?.resetsAt) parts.push(`resets ${new Date(window.resetsAt * 1000).toLocaleTimeString()}`);
    return { kind: 'limit', text: `rate limit · ${parts.filter(Boolean).join(' · ')}` };
  }
  return used ? { kind: 'note', text: `quota · ${used}` } : null;
}

// claude's `system` frames are mostly subagent bookkeeping, and the subtype is the
// only field that says which kind of row it is. Several subtypes carry nothing else,
// which is what null is for.
function describeSystem(data) {
  const sub = data?.subtype;
  if (sub === 'init') {
    const tools = Array.isArray(data.tools) ? data.tools.length : 0;
    const cwd = isText(data.cwd) ? ` · ${data.cwd}` : '';
    return { kind: 'run', text: `session started${tools ? ` · ${tools} tools` : ''}${cwd}` };
  }
  if (sub === 'task_started') {
    const who = data.subagent_type || 'agent';
    const what = firstLine(data.description, 90);
    return { kind: 'agent', text: what ? `${who} started · ${what}` : `${who} started` };
  }
  if (sub === 'background_tasks_changed') {
    const tasks = Array.isArray(data.tasks) ? data.tasks : [];
    if (!tasks.length) return { kind: 'agent', text: 'no agents running' };
    return { kind: 'agent', text: `agents running · ${tasks.map((t) => firstLine(t.description, 40)).join(', ')}` };
  }
  if (sub === 'task_progress') {
    const usage = data.usage || {};
    const bits = [
      usage.total_tokens != null ? `${formatTokens(usage.total_tokens)} tok` : '',
      usage.tool_uses != null ? `${usage.tool_uses} tool${usage.tool_uses === 1 ? '' : 's'}` : '',
      usage.duration_ms != null ? formatDuration(usage.duration_ms) : '',
    ]
      .filter(Boolean)
      .join(', ');
    const who = data.subagent_type || 'agent';
    const what = firstLine(data.description, 90);
    return { kind: 'agent', text: `${who} · ${what}${bits ? ` · ${bits}` : ''}` };
  }
  if (sub === 'task_notification') {
    const summary = firstLine(data.summary, 110);
    const status = data.status || 'finished';
    return { kind: 'agent', text: summary ? `agent ${status} · ${summary}` : `agent ${status}` };
  }
  if (sub === 'task_updated') {
    const status = data.patch?.status;
    return status ? { kind: 'agent', text: `agent ${status}` } : null;
  }
  if (sub === 'informational') {
    const text = firstLine(data.content, 240);
    return text ? { kind: 'note', text } : null;
  }
  const body = firstLine(data?.content, 240);
  return body ? { kind: 'note', text: body } : null;
}

export function describeEvent(event) {
  const type = event?.type;
  const data = event?.data;
  if (data == null) return null;

  // The service synthesises these three rather than passing claude's frames through
  // unchanged, so each has a shape of its own.
  if (type === 'started') {
    const role = data.role || 'agent';
    return { kind: 'run', text: data.model ? `${role} started on ${data.model}` : `${role} started` };
  }
  if (type === 'completed') {
    return {
      kind: 'run',
      text: data.sessionId ? `run finished · session ${String(data.sessionId).slice(0, 8)}` : 'run finished',
    };
  }
  if (type === 'result') return describeResult(data);
  if (type === 'rate_limit_event') return describeRateLimit(data);
  // What a streaming response is doing while it is still doing it. `thinking_tokens`
  // is the CLI's own estimate of how much the model has reasoned, which is the number
  // that makes a long silence legible instead of looking like a hang.
  if (type === 'progress') {
    const what = data.kind === 'thinking' ? 'reasoning' : data.kind === 'tool_use' ? 'writing a tool call' : data.kind === 'text' ? 'writing' : 'streaming';
    const tokens = data.thinkingTokens != null ? ` · ${formatTokens(data.thinkingTokens)} tokens reasoned` : '';
    const chars = data.chars ? ` · ${formatTokens(data.chars)} chars` : '';
    return { kind: 'think', text: `${what}${tokens || chars}` };
  }

  // The test command's own rows. A `test` event is either the command that was run or
  // one line of what it printed, and the two are told apart by which field is set -
  // a line is the interesting one, because that is the suite reporting on itself.
  if (type === 'test') {
    if (data.line != null) return { kind: 'out', text: firstLine(data.line) };
    return { kind: 'run', text: `test · ${firstLine(data.command, 100)}` };
  }
  if (type === 'test_result') {
    const meta = data.durationMs != null ? formatDuration(data.durationMs) : '';
    if (!data.passed) return { kind: 'error', text: `tests failed${meta ? ` · ${meta}` : ''} — ${firstLine(data.error)}` };
    return { kind: 'done', text: meta ? `tests passed · ${meta}` : 'tests passed' };
  }

  if (typeof data === 'string') {
    const text = firstLine(data);
    return text ? { kind: 'said', text } : null;
  }

  // Order is the priority: one assistant message can carry a tool call, a paragraph
  // and a reasoning trace at once, and the tool call is the fact worth a row.
  const blocks = contentBlocks(data);
  const toolUse = blocks.find((b) => b?.type === 'tool_use');
  if (toolUse) {
    const target = toolTarget(toolUse.input);
    return { kind: 'tool', text: target ? `${toolUse.name} — ${target}` : String(toolUse.name || 'tool') };
  }
  const toolResult = blocks.find((b) => b?.type === 'tool_result');
  if (toolResult) return toolOutput(toolResult);

  const said = blocks.find((b) => b?.type === 'text' && isText(b.text));
  if (said) return { kind: 'said', text: firstLine(said.text) };

  // Reasoning is frequently redacted to an empty string with a signature beside it.
  // Those blocks carry nothing to read, and dropping them is the point.
  const thought = blocks.find((b) => b?.type === 'thinking' && isText(b.thinking));
  if (thought) return { kind: 'think', text: firstLine(thought.thinking) };

  return describeSystem(data);
}

// What a supervised session's turn did, as the steps a person would name: read this,
// edited that, ran this. One row per tool call, in order, with the call's result
// folded onto it - a failed call is marked on the step it failed rather than listed
// as a row of its own, because "the edit failed" is one fact and not two.
//
// Shared by the server, which builds the steps of every settled turn from its stored
// events, and the dashboard, which builds the turn in flight from the events it is
// being streamed - so a turn looks the same while it runs and after it has landed.
export function sessionSteps(events) {
  const steps = [];
  const byId = new Map();
  for (const e of events || []) {
    for (const b of contentBlocks(e?.data)) {
      if (b?.type === 'tool_use') {
        const step = { id: b.id || null, tool: String(b.name || 'tool'), target: toolTarget(b.input), status: 'done' };
        steps.push(step);
        if (b.id) byId.set(b.id, step);
      } else if (b?.type === 'tool_result' && b.is_error) {
        const step = byId.get(b.tool_use_id);
        if (step) {
          step.status = 'failed';
          step.error = toolOutput(b).text;
        }
      }
    }
  }
  return steps;
}

export { toolTarget };

// The one-line form, for callers with no room for a badge. Always a string: the TUI
// renders it directly into a Text node, and an event with nothing to say yields the
// empty line that node already handles.
export function formatEvent(event) {
  return describeEvent(event)?.text ?? '';
}

export function formatDuration(ms) {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

export function formatTokens(n) {
  if (n == null || n === 0) return '0';
  if (n >= 1000000) return `${trimOne(n / 1000000)}M`;
  if (n >= 1000) return `${trimOne(n / 1000)}K`;
  return String(n);
}

// "20.0M" reads as a decimal no one asked for; "1.5M" keeps its digit.
function trimOne(v) {
  const s = v.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

export function formatCost(c) {
  if (c == null || c === 0) return '$0.00';
  if (c < 0.01) return `$${c.toFixed(4)}`;
  return `$${c.toFixed(2)}`;
}

export function formatState(s) {
  const map = {
    CREATED: 'Created', CONTEXT_READY: 'Context ready', PLANNING: 'Planning',
    AWAITING_APPROVAL: 'Awaiting approval', APPROVED: 'Approved',
    IMPLEMENTING: 'Implementing', TESTING: 'Testing', REVIEWING: 'Reviewing',
    REPAIRING: 'Repairing', AWAITING_DECISION: 'Awaiting decision',
    COMPLETE: 'Complete', FAILED: 'Failed', CANCELLED: 'Cancelled'
  };
  return map[s] || s;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// A 24-hour clock stamp, which is what a person reads on a schedule and what an
// "Yesterday" line needs: "14:02" is a time, "2:02 PM" is a sentence.
function clockOf(d) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// When something happened, in the words a person would use for it.
//
// `now` is a parameter rather than a call to Date.now() so the output is a pure
// function of its inputs and can be pinned in a test. The boundary at 24 hours is
// the reason this needs a clock at all: "yesterday" is a calendar day, not a
// rolling window, so 09:00 yesterday is "Yesterday 09:00" at 10:00 today and
// still "Yesterday 09:00" at 23:00 today.
//
// The year appears only when it differs from the current one. A date from this
// year is unambiguous without it, and printing "2026" on last week's run is a
// digit nobody needs.
export function formatWhen(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const ms = now - t;
  // A timestamp from the future is clock skew, not an event: two machines
  // disagreeing about the second must not render as "in 3 seconds".
  if (ms < 0) return 'just now';
  const s = Math.floor(ms / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const then = new Date(t);
  const today = new Date(now);
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (t >= midnight - 86400000) return `Yesterday ${clockOf(then)}`;
  const year = then.getFullYear() === today.getFullYear() ? '' : ` ${then.getFullYear()}`;
  return `${then.getDate()} ${MONTHS[then.getMonth()]}${year}`;
}

// An id, short enough to read out or paste into a conversation. Eight hex
// characters are 4 billion values, which is more than enough to tell two tasks
// apart on one screen, and the full id is never far away - every caller that
// shortens one also carries the whole string in a title or a copy action.
export function shortId(id) {
  return id == null ? '' : String(id).slice(0, 8);
}

export function stateColor(s) {
  if (s === 'COMPLETE' || s === 'succeeded' || s === 'ok') return 'good';
  if (s === 'FAILED' || s === 'failed') return 'bad';
  if (s === 'AWAITING_APPROVAL' || s === 'REPAIRING' || s === 'AWAITING_DECISION' || s === 'interrupted') return 'warn';
  return '';
}

// The question a review left open, read for a screen.
//
// The column is JSON that `review()` wrote after validating it, so this parses
// rather than validates a second time. It still refuses rather than throws: a column
// is a string that can be half-written, a decision that cannot be read is a decision
// that is not there, and a screen is not the place to find that out.
//
// Every field is defaulted, because the two shapes that reach here are a decision a
// reviewer returned and one a person has since commented on - the first has an empty
// thread, and a view that rendered `undefined` under a question would be a view
// nobody could act on.
export function decisionView(text) {
  if (!text) return null;
  try {
    const d = typeof text === 'string' ? JSON.parse(text) : text;
    if (!d || typeof d !== 'object' || typeof d.question !== 'string' || !d.question.trim()) return null;
    return {
      question: d.question,
      options: (Array.isArray(d.options) ? d.options : []).map((o) => ({
        label: typeof o?.label === 'string' ? o.label : '',
        detail: typeof o?.detail === 'string' ? o.detail : '',
      })),
      recommendation: typeof d.recommendation === 'string' ? d.recommendation : '',
      thread: (Array.isArray(d.thread) ? d.thread : []).map((m) => ({
        from: m?.from === 'reviewer' ? 'reviewer' : 'user',
        text: typeof m?.text === 'string' ? m.text : '',
        verdict: typeof m?.verdict === 'string' ? m.verdict : null,
        at: typeof m?.at === 'string' ? m.at : null,
      })),
    };
  } catch {
    return null;
  }
}

// One unified diff, classified and numbered, line by line.
//
// The numbering is the whole reason this lives here rather than in the component.
// Two counters advance independently, and every line that is not content advances
// neither - so treating one file header, mode change, rename marker or no-newline
// note as content shifts both gutters from that line to the end of the diff. That
// component only ever saw a diff a reviewer chose to paste; it renders the port
// view now, where `\ No newline at end of file` is in ordinary diffs constantly.
//
// The membership test is the leading character, which is what defines a content
// line: `+`, `-`, or a space. Everything else is metadata, which is why the final
// branch is the safe one rather than a list of every marker git can emit. That
// also drops the blank separator a diff-plus-status string carries, which used to
// advance both counters by one.
//
// In this file for the same reason `describeEvent` is: the browser is served this
// file rather than a copy, so the three surfaces cannot drift, and the numbering
// is testable without a DOM. Only the hunk header's start lines are read - the
// counts beside them add nothing, because both counters are re-seeded by every
// hunk header, so a hunk with an empty side never displays a number from it.
export function diffLines(diff) {
  const out = [];
  let oldNo = 0;
  let newNo = 0;
  // True between a hunk header and the next file section. `--- ` and `+++ ` are the
  // file's headers before it and content after it: a deleted line reading `-- x`
  // renders as `--- x`, and a diff of a markdown file is full of them. `diff --git`
  // is what closes a section, and every diff git writes opens one - a fragment
  // trimmed to drop those lines would read a second file's headers as content.
  let inHunk = false;
  for (const line of String(diff ?? '').split('\n')) {
    let cls = 'diff-meta';
    let oldLabel = '';
    let newLabel = '';
    if (line.startsWith('diff --git ')) {
      // A new file section, so the `---`/`+++` that follow are headers again.
      inHunk = false;
    } else if (line.startsWith('@@')) {
      cls = 'diff-hunk';
      inHunk = true;
      // Anchored on `@@`, not on the `-`: a hunk header opens with `@@`, so a regex
      // reading `^-` never matches one and both counters start from zero. That is
      // indistinguishable from correct in a hunk starting at line 1 and wrong by the
      // hunk's start in every other, so the fix is the anchor rather than a test.
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/);
      if (m) {
        oldNo = Number(m[1]) - 1;
        newNo = Number(m[2]) - 1;
      }
    } else if (!inHunk && (line.startsWith('--- ') || line.startsWith('+++ '))) {
      cls = 'diff-file';
    } else if (line.startsWith('+')) {
      cls = 'diff-add';
      newLabel = ++newNo;
    } else if (line.startsWith('-')) {
      cls = 'diff-del';
      oldLabel = ++oldNo;
    } else if (line.startsWith(' ')) {
      cls = 'diff-ctx';
      oldLabel = ++oldNo;
      newLabel = ++newNo;
    }
    out.push({ cls, old: String(oldLabel), new: String(newLabel), text: line });
  }
  return out;
}

// A unified diff of two texts, in the shape git writes and diffLines() above reads.
//
// There was no producer for that shape anywhere: every diff in the product arrived
// from git already formatted, so a screen showing "what changed in this plan" had
// nothing to render and no way to make one. Two obvious alternatives were rejected.
// Shelling out to `git diff --no-index` would write two temp files and spawn a process
// for a screen that should be a pure function of a row. Diffing by hand somewhere else
// would be a second reader of a format this file already parses - and the two would
// drift.
//
// Plans are prose that is mostly unchanged between revisions, so the common prefix and
// suffix are trimmed before the table is built. The LCS is O(n*m) in the lines that
// actually moved, which on a plan that gained a paragraph is a handful rather than the
// few hundred a whole-document table would need - and the whole-document table would
// produce a diff so long nobody reads it.
//
// `context` is one rather than git's three: a revision is read in a panel, and the
// surrounding paragraphs are the part the reader already has in front of them.
export function unifiedDiff(oldText, newText, { label = 'plan', context = 1 } = {}) {
  // A trailing newline is not a blank line. Splitting text that ends in one leaves a
  // final '', so diffing "a\n" against "a" would report a line that neither side shows.
  const lines = (text) => {
    const l = String(text ?? '').split('\n');
    return l.length && l[l.length - 1] === '' ? l.slice(0, -1) : l;
  };
  const oldLines = lines(oldText);
  const newLines = lines(newText);

  let pre = 0;
  while (pre < oldLines.length && pre < newLines.length && oldLines[pre] === newLines[pre]) pre++;
  let suf = 0;
  while (suf < oldLines.length - pre && suf < newLines.length - pre && oldLines[oldLines.length - 1 - suf] === newLines[newLines.length - 1 - suf]) suf++;
  const o = oldLines.slice(pre, oldLines.length - suf);
  const n = newLines.slice(pre, newLines.length - suf);
  // Identical text produces no diff rather than an empty diff, because the caller asks
  // "is there anything to show" and '' is the honest answer to it.
  if (!o.length && !n.length) return '';

  // The table is filled from the end so the walk below can commit to a direction as
  // soon as it knows which side is worth keeping, rather than backtracking through it.
  const dp = Array.from({ length: o.length + 1 }, () => new Int32Array(n.length + 1));
  for (let i = o.length - 1; i >= 0; i--) {
    for (let j = n.length - 1; j >= 0; j--) {
      dp[i][j] = o[i] === n[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  for (let i = 0, j = 0; i < o.length || j < n.length; ) {
    if (i < o.length && j < n.length && o[i] === n[j]) { ops.push({ t: ' ', text: o[i] }); i++; j++; }
    else if (i < o.length && (j >= n.length || dp[i + 1][j] >= dp[i][j + 1])) { ops.push({ t: '-', text: o[i] }); i++; }
    else { ops.push({ t: '+', text: n[j] }); j++; }
  }

  // The trimmed lines come back as context, so the hunks below can be numbered by
  // walking one sequence rather than by arithmetic on two.
  const all = [
    ...oldLines.slice(0, pre).map((text) => ({ t: ' ', text })),
    ...ops,
    ...oldLines.slice(oldLines.length - suf).map((text) => ({ t: ' ', text })),
  ];
  let oldNo = 1;
  let newNo = 1;
  for (const op of all) {
    if (op.t === ' ') { op.old = oldNo++; op.new = newNo++; }
    else if (op.t === '-') op.old = oldNo++;
    else op.new = newNo++;
  }

  // One hunk per run of changes plus its context, and two runs merge when the gap
  // between them is no wider than the context they would otherwise repeat.
  const ranges = [];
  for (let i = 0; i < all.length; i++) {
    if (all[i].t === ' ') continue;
    const start = Math.max(0, i - context);
    const end = Math.min(all.length, i + context + 1);
    const last = ranges[ranges.length - 1];
    if (last && start <= last.end) last.end = Math.max(last.end, end);
    else ranges.push({ start, end });
  }

  const out = [`diff --git a/${label} b/${label}`, `--- a/${label}`, `+++ b/${label}`];
  for (const r of ranges) {
    const hunk = all.slice(r.start, r.end);
    const oldCount = hunk.filter((op) => op.t !== '+').length;
    const newCount = hunk.filter((op) => op.t !== '-').length;
    // A side with no lines starts at 0, which is git's own spelling for it - a hunk
    // that adds lines to an empty side has no line to point at.
    const first = (side) => hunk.find((op) => op[side] !== undefined);
    out.push(`@@ -${first('old') ? first('old').old : 0},${oldCount} +${first('new') ? first('new').new : 0},${newCount} @@`);
    for (const op of hunk) out.push(op.t + op.text);
  }
  return out.join('\n');
}

// The same unified diff, paired into side-by-side rows.
//
// A split view is a pairing problem rather than a second reading of the diff: which
// old line sits opposite which new one. The rule here is GitHub's, because it is the
// one people already read - a run of deletions pairs positionally with the run of
// additions after it - and the shorter of the two is padded, so a row still belongs
// to the change even where only one side has a line.
//
// Each side is reduced here to its number, its text and its class rather than in the
// component, so which number belongs to which side is decided once and has a test
// that needs no DOM. `null` is the padded side. Rows that are not lines at all - a
// file header, a mode change, a hunk header - come through as a `span`, because they
// are about the diff rather than about either version of a line.
export function diffSides(diff) {
  const out = [];
  let del = [];
  let add = [];
  // A deletion counts under the old file's numbering and an addition under the new
  // file's, and an unchanged line under both at once, by two different numbers.
  const cell = (line, side) => (line ? { no: side === 'new' ? line.new : line.old, text: line.text, cls: line.cls } : null);
  const pair = () => {
    for (let i = 0; i < Math.max(del.length, add.length); i++) {
      out.push({ kind: 'pair', left: cell(del[i], 'old'), right: cell(add[i], 'new') });
    }
    del = [];
    add = [];
  };
  for (const l of diffLines(diff)) {
    if (l.cls === 'diff-del') del.push(l);
    else if (l.cls === 'diff-add') add.push(l);
    else {
      // A run ends at anything that is not a deletion or an addition, which includes
      // the hunk header - so no pairing crosses a hunk, and no line of one hunk is
      // held over to pair against a line of the next.
      pair();
      out.push(l.cls === 'diff-ctx' ? { kind: 'pair', left: cell(l, 'old'), right: cell(l, 'new') } : { kind: 'span', line: l });
    }
  }
  pair();
  return out;
}

// A diff as the files it touches, for a viewer that draws one box per file. The line
// rules are diffLines' own; what this adds is the grouping, and three things only a
// file-level reader needs.
//
// A hunk ends where its header says it does. The `@@` counts are how many old and new
// lines it holds, and reading them is what tells a context line from what follows the
// hunk. The port view appends `git status --short` to its diff, and a line reading
// ` M src/app.mjs` is a context line to any reader that goes by the first character.
// Of those status lines only `??` says something the diff cannot - an untracked file,
// which no diff carries - so it becomes an entry of its own and the rest are dropped:
// every other status names a file the diff already has.
//
// The git headers (`diff --git`, `index`, `---`, `+++`, modes, renames) are read into
// the entry and not kept as lines, because the file header states them.
//
// `key` changes when the file's section of the diff does, so a mark stored against it
// ("viewed") lapses on its own when the file changes underneath it.
//
// `extra` is anything before the first file: a reviewer that answered with prose and
// then a diff has its prose kept rather than silently dropped.
export function diffFiles(diff) {
  const files = [];
  const extra = [];
  let f = null;
  let hunk = null;
  let oldLeft = 0;
  let newLeft = 0;
  let oldNo = 0;
  let newNo = 0;
  const strip = (p) => p.replace(/^[ab]\//, '');
  const open = (path, from) => {
    f = { path, from: from ?? path, status: 'M', similarity: null, notes: [], hunks: [], add: 0, del: 0, raw: [] };
    files.push(f);
    hunk = null;
    return f;
  };
  for (const line of String(diff ?? '').split('\n')) {
    if (hunk && (oldLeft > 0 || newLeft > 0)) {
      f.raw.push(line);
      if (line.startsWith('\\')) continue;
      const c = line[0];
      if (c === '+') {
        newLeft--;
        f.add++;
        hunk.lines.push({ cls: 'diff-add', old: '', new: String(++newNo), text: line.slice(1) });
      } else if (c === '-') {
        oldLeft--;
        f.del++;
        hunk.lines.push({ cls: 'diff-del', old: String(++oldNo), new: '', text: line.slice(1) });
      } else {
        oldLeft--;
        newLeft--;
        hunk.lines.push({ cls: 'diff-ctx', old: String(++oldNo), new: String(++newNo), text: line.slice(1) });
      }
      continue;
    }
    hunk = null;
    if (line.startsWith('diff --git ')) {
      const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      open(m ? m[2] : line.slice(11), m ? m[1] : undefined).raw.push(line);
      continue;
    }
    const st = line.match(/^(\?\?|[ MADRCU!][ MADRCU!]) (.+)$/);
    if (st && st[1] !== '  ' && (st[1] === '??' || files.length)) {
      if (st[1] === '??') {
        const path = st[2].replace(/^"(.*)"$/, '$1');
        files.push({ path, from: path, status: 'U', similarity: null, notes: [], hunks: [], add: 0, del: 0, raw: [line] });
      }
      f = null;
      continue;
    }
    if (line.startsWith('--- ')) {
      // A diff with no `diff --git` line - one a model wrote - opens its file here.
      if (!f || f.hunks.length) open(strip(line.slice(4)));
      else if (line.slice(4) !== '/dev/null') f.from = strip(line.slice(4));
      f.raw.push(line);
      continue;
    }
    if (!f) {
      if (line.trim()) extra.push(line);
      continue;
    }
    f.raw.push(line);
    if (line.startsWith('+++ ')) {
      if (line.slice(4) !== '/dev/null') f.path = strip(line.slice(4));
    } else if (line.startsWith('@@')) {
      const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/);
      if (!m) continue;
      hunk = { oldStart: +m[1], oldLen: +(m[2] ?? 1), newStart: +m[3], newLen: +(m[4] ?? 1), fn: m[5] || '', lines: [] };
      oldLeft = hunk.oldLen;
      newLeft = hunk.newLen;
      oldNo = hunk.oldStart - 1;
      newNo = hunk.newStart - 1;
      f.hunks.push(hunk);
    } else if (line.startsWith('new file')) f.status = 'A';
    else if (line.startsWith('deleted file')) f.status = 'D';
    else if (line.startsWith('rename from ')) { f.status = 'R'; f.from = line.slice(12); }
    else if (line.startsWith('rename to ')) f.path = line.slice(10);
    else if (line.startsWith('similarity index ')) f.similarity = line.slice(17);
    else if (line.startsWith('old mode ')) f.oldMode = line.slice(9);
    else if (line.startsWith('new mode ')) f.notes.push(`Mode changed ${f.oldMode || ''} → ${line.slice(9)}`.replace('  ', ' '));
    else if (line.startsWith('Binary files')) f.notes.push('Binary file changed. Contents not shown.');
  }
  for (const x of files) {
    if (x.status === 'U') x.notes.push('New untracked file. It will be committed with the change, but its contents are not in the diff.');
    x.key = hashText(x.raw.join('\n'));
    delete x.raw;
    delete x.oldMode;
  }
  return { files, extra };
}

// The highlight.js language for a path, or null when there is none worth trying.
// By extension, plus the few files whose name is their type. Guessing a language from
// content is left out on purpose: on a fragment of a file - which is all a hunk is -
// the guess is wrong often enough to be worse than plain text.
const LANGUAGES = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin',
  swift: 'swift', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', cs: 'csharp',
  php: 'php', sh: 'bash', bash: 'bash', zsh: 'bash', json: 'json', webmanifest: 'json',
  yml: 'yaml', yaml: 'yaml', md: 'markdown', markdown: 'markdown',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', css: 'css', scss: 'scss', less: 'less',
  sql: 'sql', toml: 'ini', ini: 'ini', lua: 'lua', r: 'r', pl: 'perl', graphql: 'graphql', gql: 'graphql',
};
const NAMED = { makefile: 'makefile', gemfile: 'ruby', rakefile: 'ruby' };
export function diffLanguage(path) {
  const name = String(path || '').split('/').pop().toLowerCase();
  if (NAMED[name]) return NAMED[name];
  const dot = name.lastIndexOf('.');
  return dot > 0 ? LANGUAGES[name.slice(dot + 1)] || null : null;
}

// Highlighted HTML cut into one string per source line, each with its spans balanced.
// A hunk side is highlighted as one block so a string or comment that runs over
// several lines keeps its colour on all of them - which leaves spans that open on one
// line and close on another. Each line closes what is open at its end and the next
// reopens it, so every line can be rendered on its own.
//
// It reads only the shape highlight.js writes: `<span class="...">`, `</span>` and
// escaped text. Anything else is passed through as text.
export function splitHighlighted(html) {
  const lines = [];
  const open = [];
  let line = '';
  const re = /(<span[^>]*>)|(<\/span>)|(\n)|([^<\n]+|<)/g;
  let m;
  while ((m = re.exec(String(html ?? '')))) {
    if (m[1]) {
      open.push(m[1]);
      line += m[1];
    } else if (m[2]) {
      open.pop();
      line += m[2];
    } else if (m[3]) {
      lines.push(line + '</span>'.repeat(open.length));
      line = open.join('');
    } else {
      line += m[4];
    }
  }
  lines.push(line + '</span>'.repeat(open.length));
  return lines;
}

// FNV-1a over the text, as eight hex digits. A change detector, not a digest: two
// sections colliding costs a stale "viewed" mark and nothing else.
function hashText(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// How a block of model text should be displayed. A plan and a reviewer's verdict
// are markdown; a reviewer that answered with a diff is a diff, and sending one
// through a markdown renderer mangles it. This decision lived inline in the task
// detail view, where nothing tested it.
export function bodyKind(text) {
  if (!text || !text.trim()) return 'empty';
  // `--- ` and `+++ ` also open a markdown thematic break, and a break written with
  // a trailing space is indistinguishable from a diff header unless the marker is
  // required to be followed by a path - which it always is, since git names a file
  // on both lines. A bare `---` already fell through as markdown; this closes the
  // one-character version of the same hole.
  if (/^(diff --git |--- \S|\+\+\+ \S|@@ )/m.test(text)) return 'diff';
  return 'markdown';
}

// What a shell command does through git or the GitHub CLI, for the approval panel.
//
// A conversation that can edit may run git and gh like any other command, behind the
// same approval. The approval is only worth what the person can read off it, and
// `git pull --rebase origin main && git push -f` reads as one more command unless
// something says that it rewrites history and then leaves the machine. So each git or
// gh invocation in the command is named, and graded by how far its effect reaches:
//
//   read    looks and changes nothing (log, diff, status, fetch, gh pr view)
//   local   changes this checkout's history, branches or files (commit, merge, pull)
//   remote  changes something off this machine (push, gh pr create, gh pr merge)
//
// `destructive` marks what cannot be taken back from here: a hard reset, a force
// push, a discarded file, a deleted branch. Anything this does not recognise is graded
// local for git and remote for gh, so an unknown command reads as more consequential,
// never less. Shared by the server and the dashboard, so the panel and the list row
// say the same thing.
const LEVELS = ['read', 'local', 'remote'];
const higher = (a, b) => (LEVELS.indexOf(a) >= LEVELS.indexOf(b) ? a : b);

// Shell words, with quotes honoured and the control operators as their own tokens,
// so `git commit -m "fix; again" && git push` is two commands and not three.
function shellWords(command) {
  const out = [];
  let cur = '';
  let quote = null;
  let started = false;
  const flush = () => {
    if (started) out.push(cur);
    cur = '';
    started = false;
  };
  const s = String(command || '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < s.length) cur += s[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      started = true;
    } else if (c === '\\' && i + 1 < s.length) {
      cur += s[++i];
      started = true;
    } else if (c === '\n' || c === ';' || c === '|' || c === '&' || c === '(' || c === ')' || c === '`') {
      flush();
      // `&&`, `||` and `|&` are one separator; `$(` leaves its `$` on no word.
      if ((c === '&' || c === '|') && (s[i + 1] === c || s[i + 1] === '&')) i++;
      out.push(';');
    } else if (c === '$' && s[i + 1] === '(') {
      flush();
    } else if (/\s/.test(c)) {
      flush();
    } else {
      cur += c;
      started = true;
    }
  }
  flush();
  return out;
}

function shellCommands(command) {
  const cmds = [];
  let words = [];
  for (const w of shellWords(command)) {
    if (w === ';') {
      if (words.length) cmds.push(words);
      words = [];
    } else words.push(w);
  }
  if (words.length) cmds.push(words);
  return cmds;
}

// The program a command runs, past the prefixes that only change how it runs.
const PREFIXES = new Set(['sudo', 'command', 'env', 'time', 'nohup', 'exec', 'xargs', 'nice']);
function programOf(words) {
  let i = 0;
  while (i < words.length && (PREFIXES.has(words[i]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || (i > 0 && PREFIXES.has(words[i - 1]) && words[i].startsWith('-')))) i++;
  const name = (words[i] || '').split('/').pop();
  return { name, args: words.slice(i + 1) };
}

const has = (args, ...flags) => args.some((a) => flags.includes(a) || flags.some((f) => f.startsWith('--') && a.startsWith(`${f}=`)));
// The arguments that are not options, skipping the value an option takes: in
// `git merge -m "msg" feature` the branch is `feature`, not the message.
// Kept per tool: the same short flag takes a value in one and not the other (`-r` is
// gh's reviewer and git's rebase).
const GIT_VALUE_FLAGS = new Set(['-m', '-F', '--message', '--file', '-s', '--strategy', '-X', '--strategy-option', '--author', '--date', '-o', '--push-option', '--exec', '--onto', '-b', '-B', '-c', '-C']);
const GH_VALUE_FLAGS = new Set(['-R', '--repo', '--hostname', '-t', '--title', '-b', '--body', '-F', '--body-file', '-B', '--base', '-H', '--head', '-l', '--label', '-a', '--assignee', '-r', '--reviewer', '-m', '--milestone', '-p', '--project', '-q', '--jq', '-T', '--template', '-X', '--method', '-f', '--field', '--raw-field', '--input', '-s', '--state', '-L', '--limit']);
const positional = (args, valueFlags = GIT_VALUE_FLAGS, keep = new Set()) => {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('-')) {
      if (valueFlags.has(args[i]) && !keep.has(args[i])) i++;
    } else out.push(args[i]);
  }
  return out;
};

const GIT_GLOBAL_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--config-env']);
const GIT_READ = new Set(['status', 'log', 'diff', 'show', 'blame', 'rev-parse', 'rev-list', 'ls-files', 'ls-tree', 'ls-remote', 'grep', 'describe', 'shortlog', 'merge-base', 'cat-file', 'name-rev', 'whatchanged', 'show-ref', 'for-each-ref', 'count-objects', 'check-ignore', 'help', 'version', 'var', 'range-diff', 'cherry', 'difftool', 'annotate', 'show-branch', 'verify-commit', 'verify-tag']);

function gitItem(args) {
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) {
    if (GIT_GLOBAL_VALUE.has(args[i])) i++;
    i++;
  }
  const sub = args[i] || '';
  const rest = args.slice(i + 1);
  // `-b` and `-B` name the new branch for checkout and switch, so their value is the
  // positional the label wants rather than one to skip.
  const pos = positional(rest, GIT_VALUE_FLAGS, sub === 'checkout' || sub === 'switch' ? new Set(['-b', '-B', '-c', '-C']) : new Set());
  const it = (level, label, destructive = false) => ({ tool: 'git', sub, level, label, destructive });
  if (!sub || has(args, '--version', '--help')) return it('read', 'Shows git help or version');
  if (GIT_READ.has(sub)) return it('read', `Reads the repository (git ${sub})`);
  switch (sub) {
    case 'fetch':
      return it('read', `Fetches from ${pos[0] || 'the remote'} without changing your branches`);
    case 'reflog':
      return pos[0] === 'expire' || pos[0] === 'delete' ? it('local', 'Deletes reflog entries', true) : it('read', 'Reads the reflog');
    case 'branch': {
      if (has(rest, '-D') || (has(rest, '-d', '--delete') && has(rest, '-f', '--force'))) return it('local', `Force-deletes branch ${pos[0] || ''}`.trim(), true);
      if (has(rest, '-d', '--delete')) return it('local', `Deletes branch ${pos[0] || ''}`.trim());
      if (has(rest, '-m', '-M', '--move')) return it('local', 'Renames a branch', has(rest, '-M'));
      if (has(rest, '-u', '--set-upstream-to', '--unset-upstream')) return it('local', 'Changes a branch upstream');
      if (pos.length && !has(rest, '-l', '--list', '-a', '-r', '--contains', '--merged', '--no-merged', '--show-current')) return it('local', `Creates branch ${pos[0]}`);
      return it('read', 'Lists branches');
    }
    case 'tag':
      if (!pos.length || has(rest, '-l', '--list', '-n', '--contains', '--points-at')) return it('read', 'Lists tags');
      return has(rest, '-d', '--delete') ? it('local', `Deletes tag ${pos[0]}`) : it('local', `Creates tag ${pos[0]}`, has(rest, '-f', '--force'));
    case 'stash': {
      const op = pos[0] || 'push';
      if (op === 'list' || op === 'show') return it('read', 'Reads the stash');
      if (op === 'drop' || op === 'clear') return it('local', op === 'clear' ? 'Deletes every stash' : 'Deletes a stash', true);
      if (op === 'pop' || op === 'apply') return it('local', 'Applies stashed changes to the checkout');
      return it('local', 'Stashes uncommitted changes');
    }
    case 'remote':
      return !pos.length || ['show', 'get-url'].includes(pos[0]) ? it('read', 'Lists remotes') : it('local', `Changes remotes (git remote ${pos[0]})`, pos[0] === 'remove' || pos[0] === 'rm');
    case 'worktree':
      return pos[0] === 'list' ? it('read', 'Lists worktrees') : it('local', `Changes worktrees (git worktree ${pos[0] || ''})`.trim(), pos[0] === 'remove' && has(rest, '-f', '--force'));
    case 'config':
      return has(rest, '--get', '--get-all', '--get-regexp', '--list', '-l', '--show-origin') || pos.length <= 1 ? it('read', 'Reads git config') : it('local', 'Changes git config');
    case 'submodule':
      return !pos.length || pos[0] === 'status' || pos[0] === 'summary' ? it('read', 'Reads submodules') : it('local', `Changes submodules (git submodule ${pos[0]})`);
    case 'commit':
      return has(rest, '--amend') ? it('local', 'Rewrites the last commit', true) : it('local', 'Commits');
    case 'merge':
      if (has(rest, '--abort', '--quit')) return it('local', 'Abandons the merge in progress');
      if (has(rest, '--continue')) return it('local', 'Concludes the merge in progress');
      return it('local', `Merges ${pos.join(' ') || 'into the current branch'}`);
    case 'pull':
      return it('local', `Pulls ${pos.slice(1).join(' ') || 'the upstream branch'} from ${pos[0] || 'the remote'} and ${has(rest, '--rebase', '-r') ? 'rebases onto it' : 'merges it'}`, has(rest, '--rebase', '-r', '--force', '-f'));
    case 'rebase':
      if (has(rest, '--abort', '--quit')) return it('local', 'Abandons the rebase in progress');
      if (has(rest, '--continue', '--skip')) return it('local', 'Continues the rebase in progress', has(rest, '--skip'));
      return it('local', `Rebases onto ${pos[0] || 'the upstream branch'}, rewriting commits`, true);
    case 'cherry-pick':
    case 'revert':
    case 'am':
      return it('local', `${sub === 'revert' ? 'Reverts' : 'Applies'} commits (git ${sub})`);
    case 'reset':
      if (has(rest, '--hard', '--merge', '--keep')) return it('local', `Resets to ${pos[0] || 'HEAD'} and discards uncommitted changes`, true);
      return it('local', pos.length ? `Moves the branch to ${pos[0]} or unstages paths` : 'Unstages changes');
    case 'checkout':
      if (has(rest, '--', '.') || has(rest, '-f', '--force')) return it('local', 'Discards changes to files', true);
      if (has(rest, '-b', '-B')) return it('local', `Creates and switches to branch ${pos[0] || ''}`.trim(), has(rest, '-B'));
      return it('local', `Switches to ${pos[0] || 'a branch'}`);
    case 'switch':
      return it('local', `Switches to ${pos[0] || 'a branch'}`, has(rest, '--discard-changes', '-f', '--force', '-C'));
    case 'restore':
      return has(rest, '--staged', '-S') && !has(rest, '--worktree', '-W') ? it('local', 'Unstages changes') : it('local', 'Discards changes to files', true);
    case 'clean':
      return has(rest, '-n', '--dry-run') ? it('read', 'Lists untracked files it would delete') : it('local', 'Deletes untracked files', true);
    case 'add':
    case 'rm':
    case 'mv':
      return it('local', sub === 'add' ? 'Stages changes' : sub === 'rm' ? 'Removes files' : 'Moves files', sub === 'rm' && has(rest, '-f', '--force'));
    case 'push': {
      const force = has(rest, '-f', '--force', '--force-with-lease', '--force-if-includes', '--mirror') || pos.some((p) => p.startsWith('+'));
      const del = has(rest, '-d', '--delete') || pos.some((p) => p.startsWith(':'));
      const target = pos.length ? `${pos.slice(1).join(' ') || 'the current branch'} to ${pos[0]}` : 'the current branch to its remote';
      if (del) return it('remote', `Deletes branch ${pos.slice(1).join(' ').replace(/^:/, '') || ''} on ${pos[0] || 'the remote'}`.replace(/\s+/g, ' '), true);
      return it('remote', `${force ? 'Force-pushes' : 'Pushes'} ${target}${has(rest, '--tags') ? ', with tags' : ''}`, force);
    }
    case 'send-email':
    case 'request-pull':
      return it('remote', `Sends patches (git ${sub})`);
    case 'filter-branch':
    case 'filter-repo':
      return it('local', 'Rewrites history across the repository', true);
    case 'clone':
    case 'init':
      return it('local', sub === 'clone' ? `Clones ${pos[0] || 'a repository'}` : 'Creates a repository');
    default:
      return it('local', `Runs git ${sub}`);
  }
}

const GH_GLOBAL_VALUE = new Set(['-R', '--repo', '--hostname']);
const GH_READ = {
  pr: ['view', 'diff', 'list', 'checks', 'status'],
  issue: ['view', 'list', 'status'],
  repo: ['view', 'list'],
  run: ['view', 'list', 'watch', 'download'],
  workflow: ['view', 'list'],
  release: ['view', 'list', 'download'],
  gist: ['view', 'list'],
  label: ['list'],
  cache: ['list'],
  secret: ['list'],
  variable: ['list', 'get'],
  auth: ['status', 'token'],
  ruleset: ['view', 'list', 'check'],
  project: ['view', 'list', 'item-list', 'field-list'],
};
const GH_LOCAL = { pr: ['checkout'], repo: ['clone', 'set-default'], gist: ['clone'], auth: ['setup-git'] };
const GH_DESTRUCTIVE = new Set(['delete', 'archive', 'transfer']);
const GH_VERBS = {
  create: 'Creates',
  merge: 'Merges',
  close: 'Closes',
  reopen: 'Reopens',
  edit: 'Edits',
  comment: 'Comments on',
  review: 'Reviews',
  ready: 'Marks ready',
  delete: 'Deletes',
  fork: 'Forks',
  rename: 'Renames',
  archive: 'Archives',
  sync: 'Syncs',
  transfer: 'Transfers',
  lock: 'Locks',
  unlock: 'Unlocks',
  pin: 'Pins',
  run: 'Runs',
  rerun: 'Re-runs',
  cancel: 'Cancels',
  enable: 'Enables',
  disable: 'Disables',
  set: 'Sets',
  upload: 'Uploads to',
};

function ghItem(args) {
  const words = [];
  for (let i = 0; i < args.length; i++) {
    if (GH_GLOBAL_VALUE.has(args[i])) i++;
    else words.push(args[i]);
  }
  const [group = '', action = ''] = positional(words, GH_VALUE_FLAGS);
  const rest = words.slice(words.indexOf(action) + 1);
  // The thing acted on is the word right after the action - `gh pr view 42` - and
  // never a word after an option, which is that option's value.
  const ref = rest[0] && !rest[0].startsWith('-') ? rest[0] : '';
  const noun = { pr: 'pull request', issue: 'issue', repo: 'repository', run: 'workflow run', workflow: 'workflow', release: 'release', gist: 'gist', label: 'label', secret: 'secret', variable: 'variable', cache: 'cache', ruleset: 'ruleset', project: 'project' }[group] || group;
  const it = (level, label, destructive = false) => ({ tool: 'gh', sub: `${group} ${action}`.trim(), level, label, destructive });
  if (!group || has(args, '--version', '--help', '-h') || ['help', 'version', 'status', 'browse', 'search', 'completion'].includes(group)) return it('read', `Reads from GitHub (gh ${group || 'help'})`);
  if (group === 'api') {
    // GET unless a method or a field says otherwise: gh api turns fields into a POST.
    const m = words.findIndex((w) => w === '-X' || w === '--method');
    const method = (m >= 0 ? words[m + 1] : (words.find((w) => w.startsWith('--method=')) || '').split('=')[1]) || (has(words, '-f', '-F', '--field', '--raw-field', '--input') ? 'POST' : 'GET');
    const path = positional(words.slice(1), GH_VALUE_FLAGS)[0] || '';
    return method.toUpperCase() === 'GET' ? it('read', `Reads ${path} from the GitHub API`) : it('remote', `Sends ${method.toUpperCase()} ${path} to the GitHub API`, method.toUpperCase() === 'DELETE');
  }
  if (GH_READ[group]?.includes(action) || (group === 'gist' && !action)) {
    return it('read', action === 'list' ? `Lists ${noun}s on GitHub` : action === 'diff' ? `Reads the diff of pull request ${ref}`.trim() : `Reads ${noun}${ref ? ` ${ref}` : 's'} from GitHub`);
  }
  if (GH_LOCAL[group]?.includes(action)) return it('local', group === 'pr' ? `Checks out pull request ${ref || ''} into this checkout`.trim() : `Runs gh ${group} ${action} locally`);
  if (group === 'pr' && action === 'review') {
    const kind = has(rest, '-a', '--approve') ? 'Approves' : has(rest, '-r', '--request-changes') ? 'Requests changes on' : 'Comments on';
    return it('remote', `${kind} pull request ${ref || ''} on GitHub`.replace(/\s+on GitHub$/, ' on GitHub'));
  }
  if (group === 'pr' && action === 'merge') {
    const how = has(rest, '--squash', '-s') ? 'Squash-merges' : has(rest, '--rebase', '-r') ? 'Rebase-merges' : 'Merges';
    return it('remote', `${how} pull request ${ref || ''} on GitHub${has(rest, '-d', '--delete-branch') ? ' and deletes its branch' : ''}`.replace(/\s+on/, ' on'), has(rest, '--admin'));
  }
  const verb = GH_VERBS[action] || `Runs gh ${group} ${action}:`;
  return it('remote', `${verb} ${GH_VERBS[action] ? `${noun}${ref ? ` ${ref}` : ''}` : ''} on GitHub`.replace(/\s+/g, ' ').replace(': on', ' on'), GH_DESTRUCTIVE.has(action));
}

export function gitImpact(command) {
  const items = [];
  for (const words of shellCommands(command)) {
    const { name, args } = programOf(words);
    if (name === 'git') items.push(gitItem(args));
    else if (name === 'gh') items.push(ghItem(args));
  }
  if (!items.length) return null;
  return {
    level: items.reduce((l, x) => higher(l, x.level), 'read'),
    destructive: items.some((x) => x.destructive),
    items,
  };
}
