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
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

export function formatCost(c) {
  if (c == null || c === 0) return '$0.00';
  if (c < 0.01) return `$${c.toFixed(4)}`;
  return `$${c.toFixed(2)}`;
}

export function formatState(s) {
  const map = {
    CREATED: 'Created', CONTEXT_READY: 'Context Ready', PLANNING: 'Planning',
    AWAITING_APPROVAL: 'Awaiting Approval', APPROVED: 'Approved',
    IMPLEMENTING: 'Implementing', TESTING: 'Testing', REVIEWING: 'Reviewing',
    REPAIRING: 'Repairing', COMPLETE: 'Complete', FAILED: 'Failed'
  };
  return map[s] || s;
}

export function stateColor(s) {
  if (s === 'COMPLETE' || s === 'succeeded' || s === 'ok') return 'good';
  if (s === 'FAILED' || s === 'failed') return 'bad';
  if (s === 'AWAITING_APPROVAL' || s === 'REPAIRING' || s === 'interrupted') return 'warn';
  return '';
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
