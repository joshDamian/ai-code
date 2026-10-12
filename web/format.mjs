// Formatting shared by the views: times, costs, token counts, and the diff parser
// the diff viewer renders from.

export function formatDuration(ms) {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
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

// A short stable hash of a text, for keying what a reader marked as viewed.
function hashText(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
