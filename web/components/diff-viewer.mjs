// Diff viewer: one box per file, in two layouts.
//
// A diff is read file by file, so each file is its own bordered box with a header
// that stays pinned while the file scrolls past: what happened to it, where it is,
// and how much of it changed. Git's own header lines (`diff --git`, `index`, `---`,
// `+++`) are read into that header rather than printed, which is what used to make
// every file boundary look like the three lines of plumbing around it.
//
// Unified is the default: it is what a reviewer reads and what the port assessment is
// written about. Split puts the old and the new version of a line beside each other,
// which is what makes a rewrite legible as a rewrite rather than as a deletion
// followed by an unrelated addition.
//
// The grouping comes from diffFiles() in src/format.mjs, which the browser is served
// rather than a copy of, so what decides where a file or a hunk ends is the same code
// here as in its tests.
//
// `nav` adds the file list beside the diff. `storageKey` turns on the Viewed marks and
// keeps them across reloads; each mark is stored against a hash of the file's section
// of the diff, so a file that changes after it was marked comes back unviewed.
// `untracked` names the sizes of files the diff can only list.
//
// Syntax colour comes from highlight.js, fetched the first time a diff is shown and
// never before: the viewer renders plain text until it arrives, and stays plain if it
// cannot be fetched. Each hunk's old and new side is highlighted as one block, so a
// string or comment that spans lines is coloured on all of them, then cut back into
// lines by splitHighlighted().
import { html, useState, useMemo, useRef, useEffect, diffFiles, diffLanguage, splitHighlighted } from '../lib.mjs';
import { showToast } from './toast.mjs';

// A file with more changed lines than this starts folded behind a button. Past a few
// hundred lines a diff is scrolled through rather than read, and it pushes every file
// after it off the screen.
const LARGE_LINES = 400;

// Past this many lines in one file, highlighting costs more than it gives back.
const HIGHLIGHT_LINES = 3000;

// Whether the file list is hidden. One setting for every viewer, remembered in this
// browser: it is a preference about the screen, not about a task.
const WIDE_KEY = 'ai-code:diff-wide';

let hljsLoad = null;
function loadHighlighter() {
  hljsLoad ||= import('highlight.js').then((m) => m.default).catch(() => null);
  return hljsLoad;
}

// One HTML string per line of each hunk, in the hunk's own line order, or null when
// the file has no language to highlight. The two sides are highlighted separately
// because each is a coherent piece of source and the mix of them is not.
function highlightFile(hljs, f) {
  const lang = diffLanguage(f.path);
  if (!hljs || !lang || !hljs.getLanguage(lang)) return null;
  if (f.hunks.reduce((n, h) => n + h.lines.length, 0) > HIGHLIGHT_LINES) return null;
  const side = (lines) => splitHighlighted(hljs.highlight(lines.map((l) => l.text).join('\n'), { language: lang, ignoreIllegals: true }).value);
  return f.hunks.map((h) => {
    const older = side(h.lines.filter((l) => l.cls !== 'diff-add'));
    const newer = side(h.lines.filter((l) => l.cls !== 'diff-del'));
    let o = 0;
    let n = 0;
    return h.lines.map((l) => {
      if (l.cls === 'diff-del') return older[o++];
      if (l.cls === 'diff-add') return newer[n++];
      o++;
      return newer[n++];
    });
  });
}

const STATUS = { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', U: 'Untracked' };

function storeKey(key) {
  return `ai-code:viewed:${key}`;
}

// localStorage throws in some privacy modes; a viewer that cannot remember what was
// viewed still has to render, so a failed read is an empty record.
function loadViewed(key) {
  if (!key) return {};
  try {
    return JSON.parse(localStorage.getItem(storeKey(key)) || '{}') || {};
  } catch {
    return {};
  }
}

function saveViewed(key, value) {
  if (!key) return;
  try {
    if (Object.keys(value).length) localStorage.setItem(storeKey(key), JSON.stringify(value));
    else localStorage.removeItem(storeKey(key));
  } catch {
    // Storage unavailable: the marks still hold for this page.
  }
}

function splitPath(p) {
  const i = p.lastIndexOf('/');
  return i < 0 ? ['', p] : [p.slice(0, i + 1), p.slice(i + 1)];
}

function formatBytes(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function DiffViewer({ diff, nav = false, storageKey = null, untracked = null }) {
  const [split, setSplit] = useState(false);
  // What the reader toggled, by path. Absent means the default: open, unless the file
  // is viewed or large.
  const [folded, setFolded] = useState({});
  const [viewed, setViewed] = useState(() => loadViewed(storageKey));
  const [wide, setWide] = useState(() => {
    try {
      return localStorage.getItem(WIDE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [hljs, setHljs] = useState(null);
  const boxes = useRef({});
  const parsed = useMemo(() => diffFiles(diff), [diff]);
  useEffect(() => {
    let live = true;
    loadHighlighter().then((h) => live && h && setHljs(() => h));
    return () => {
      live = false;
    };
  }, []);
  if (!diff) return null;
  const { files, extra } = parsed;
  const sizes = Object.fromEntries((untracked || []).map((u) => [u.path, u.bytes]));

  const isViewed = (f) => !!storageKey && viewed[f.path] === f.key;
  const isLarge = (f) => f.add + f.del > LARGE_LINES;
  const isFolded = (f) => (f.path in folded ? folded[f.path] : isViewed(f));

  const setMark = (f, on) => {
    // Rebuilt from the current files, so marks for paths no longer in the diff, or
    // against an older version of a file, are dropped on the next write.
    const next = {};
    for (const x of files) if (x.path === f.path ? on : isViewed(x)) next[x.path] = x.key;
    setViewed(next);
    saveViewed(storageKey, next);
    setFolded((s) => ({ ...s, [f.path]: on }));
  };

  const allFolded = files.every(isFolded);
  const toggleAll = () => setFolded(Object.fromEntries(files.map((f) => [f.path, !allFolded])));
  const jump = (f) => {
    setFolded((s) => ({ ...s, [f.path]: false }));
    boxes.current[f.path]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const add = files.reduce((n, f) => n + f.add, 0);
  const del = files.reduce((n, f) => n + f.del, 0);
  const seen = storageKey ? files.filter(isViewed).length : 0;
  const hasNav = nav && files.length > 1;
  const withNav = hasNav && !wide;
  const toggleWide = () => {
    setWide(!wide);
    try {
      localStorage.setItem(WIDE_KEY, wide ? '0' : '1');
    } catch {
      // Not remembered, still toggled.
    }
  };

  return html`
    <div class="dv">
      <div class="dv-head">
        <div class="dv-sum">
          <span>${files.length} file${files.length === 1 ? '' : 's'}</span>
          <span class="dv-add">+${add}</span>
          <span class="dv-del">−${del}</span>
          ${seen ? html`<span class="muted">· ${seen} of ${files.length} viewed</span>` : null}
        </div>
        <div class="dv-ctrl">
          ${hasNav
            ? html`<button class="btn secondary dv-wide" type="button" aria-pressed=${wide} title=${wide ? 'Show the file list' : 'Hide the file list and widen the diff'} onClick=${toggleWide}>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
                  <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" />
                  ${wide ? html`<path d="M5.5 2.75v10.5" />` : html`<path d="M9 6l2 2-2 2M5 8h6" />`}
                </svg>
                ${wide ? 'Show files' : 'Expand'}
              </button>`
            : null}
          ${files.length > 1 ? html`<button class="btn secondary" type="button" onClick=${toggleAll}>${allFolded ? 'Expand all' : 'Collapse all'}</button>` : null}
          <div class="dv-seg" role="group" aria-label="Diff layout">
            <button class="btn secondary ${split ? '' : 'on'}" type="button" aria-pressed=${!split} onClick=${() => setSplit(false)}>Unified</button>
            <button class="btn secondary ${split ? 'on' : ''}" type="button" aria-pressed=${split} onClick=${() => setSplit(true)}>Split</button>
          </div>
        </div>
      </div>
      ${extra.length ? html`<pre class="dv-extra">${extra.join('\n')}</pre>` : null}
      <div class="dv-body ${withNav ? 'with-nav' : ''}">
        ${withNav
          ? html`<nav class="dv-nav" aria-label="Changed files">
              ${files.map((f) => {
                const [dir, base] = splitPath(f.path);
                return html`<button class="dv-nav-item ${isViewed(f) ? 'viewed' : ''}" type="button" key=${f.path} title=${f.path} onClick=${() => jump(f)}>
                  <${Status} s=${f.status} />
                  <span class="dv-nav-name"><span class="muted">${dir}</span>${base}</span>
                  ${f.add + f.del ? html`<span class="dv-nav-count"><span class="dv-add">+${f.add}</span> <span class="dv-del">−${f.del}</span></span>` : html`<span></span>`}
                </button>`;
              })}
            </nav>`
          : null}
        <div class="dv-files">
          ${files.map(
            (f) => html`<${FileBox}
              key=${f.path}
              f=${f}
              split=${split}
              folded=${isFolded(f)}
              large=${isLarge(f)}
              viewed=${isViewed(f)}
              markable=${!!storageKey}
              hljs=${hljs}
              size=${sizes[f.path]}
              boxRef=${(el) => (boxes.current[f.path] = el)}
              onFold=${() => setFolded((s) => ({ ...s, [f.path]: !isFolded(f) }))}
              onViewed=${(on) => setMark(f, on)}
            />`
          )}
        </div>
      </div>
    </div>
  `;
}

function Status({ s }) {
  return html`<span class="dv-st dv-st-${s}" title=${STATUS[s]} aria-label=${STATUS[s]}>${s}</span>`;
}

// GitHub's five-cell bar: the share of added to deleted lines, rounded to cells, with
// at least one cell for each side that has any.
function Bar({ add, del }) {
  if (!add && !del) return null;
  const a = !add ? 0 : del ? Math.max(1, Math.min(4, Math.round((add / (add + del)) * 5))) : 5;
  return html`<span class="dv-bar" aria-hidden="true">${[0, 1, 2, 3, 4].map((i) => html`<i class=${i < a ? 'a' : 'd'} key=${i}></i>`)}</span>`;
}

function FileBox({ f, split, folded, large, viewed, markable, hljs, size, boxRef, onFold, onViewed }) {
  const [showLarge, setShowLarge] = useState(false);
  const shown = !folded && (!large || showLarge);
  // Only a file that is on screen is highlighted, and only once per version of it.
  const colour = useMemo(() => (shown ? highlightFile(hljs, f) : null), [shown, hljs, f.key]);
  const [dir, base] = splitPath(f.path);
  const copy = () =>
    navigator.clipboard.writeText(f.path).then(
      () => showToast('Path copied.', 'success'),
      () => showToast(f.path)
    );
  const hidden = large && !showLarge;
  return html`
    <article class="dv-file ${folded ? 'folded' : ''} ${viewed ? 'viewed' : ''}" ref=${boxRef}>
      <header class="dv-fh">
        <button class="dv-chev" type="button" aria-expanded=${!folded} aria-label=${folded ? 'Expand file' : 'Collapse file'} onClick=${onFold}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m3 4.5 3 3 3-3" /></svg>
        </button>
        <${Status} s=${f.status} />
        <span class="dv-path" title=${f.path}>
          <bdi>
            ${f.status === 'R' && f.from !== f.path ? html`<span class="dv-from">${f.from}</span>${' → '}` : null}
            <span class="muted">${dir}</span><b>${base}</b>
          </bdi>
        </span>
        <button class="dv-icon" type="button" title="Copy path" aria-label="Copy path" onClick=${copy}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="5" y="5" width="8.5" height="8.5" rx="1.5" /><path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" /></svg>
        </button>
        <span class="dv-meta">
          ${f.similarity ? html`<span class="muted dv-sim">${f.similarity} similar</span>` : null}
          ${f.add + f.del ? html`<span class="dv-add">+${f.add}</span><span class="dv-del">−${f.del}</span>` : null}
          <${Bar} add=${f.add} del=${f.del} />
          ${markable
            ? html`<label class="dv-viewed">
                <input type="checkbox" checked=${viewed} onChange=${(e) => onViewed(e.currentTarget.checked)} /> Viewed
              </label>`
            : null}
        </span>
      </header>
      ${folded
        ? null
        : html`<div class="dv-code ${colour ? 'hl' : ''}">
            ${hidden
              ? html`<button class="dv-large" type="button" onClick=${() => setShowLarge(true)}>
                  Large change: ${(f.add + f.del).toLocaleString()} changed lines hidden. Show them
                </button>`
              : f.hunks.map((h, i) => html`<${Hunk} h=${h} colour=${colour?.[i]} split=${split} key=${i} />`)}
            ${f.notes.map((n, i) => html`<div class="dv-note" key=${`n${i}`}>${n}${f.status === 'U' && size != null ? ` (${formatBytes(size)})` : ''}</div>`)}
            ${!f.hunks.length && !f.notes.length ? html`<div class="dv-note">No line changes.</div>` : null}
          </div>`}
    </article>
  `;
}

// A hunk opens with a seam that names the enclosing function, git's own `@@` context,
// with the line range it covers pushed to the right.
function Hunk({ h, colour, split }) {
  const range = h.newLen
    ? `lines ${h.newStart}–${h.newStart + h.newLen - 1}`
    : `removed lines ${h.oldStart}–${h.oldStart + h.oldLen - 1}`;
  return html`
    <div class="dv-hunk"><span>@@</span><span class="dv-fn">${h.fn}</span><span class="dv-range">${range}</span></div>
    ${split ? html`<${SplitRows} lines=${h.lines} colour=${colour} />` : h.lines.map((l, i) => html`<${Row} l=${l} code=${colour?.[i]} key=${i} />`)}
  `;
}

// A line's text, as highlighted HTML when there is some. highlight.js escapes the
// source it is given, so what it returns is markup it wrote around escaped text.
function Text({ text, code, cls = '' }) {
  return code
    ? html`<span class="dv-txt ${cls}" dangerouslySetInnerHTML=${{ __html: code }}></span>`
    : html`<span class="dv-txt ${cls}">${text || ' '}</span>`;
}

function Row({ l, code }) {
  const kind = l.cls === 'diff-add' ? 'add' : l.cls === 'diff-del' ? 'del' : 'ctx';
  return html`
    <div class="dv-row ${kind}">
      <span class="dv-ln">${l.old}</span>
      <span class="dv-ln">${l.new}</span>
      <span class="dv-sign">${kind === 'add' ? '+' : kind === 'del' ? '−' : ''}</span>
      <${Text} text=${l.text} code=${code} />
    </div>
  `;
}

// A run of deletions is paired with the run of additions after it, so a rewritten line
// sits opposite its replacement. Pairing stays inside the hunk, the same rule
// diffSides() follows. The empty half of a row is drawn rather than left out, so the
// columns still line up with the rows around it.
function SplitRows({ lines: raw, colour }) {
  const lines = colour ? raw.map((l, i) => ({ ...l, code: colour[i] })) : raw;
  const rows = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].cls === 'diff-ctx') {
      rows.push([lines[i], lines[i]]);
      i++;
      continue;
    }
    const dels = [];
    const adds = [];
    while (i < lines.length && lines[i].cls === 'diff-del') dels.push(lines[i++]);
    while (i < lines.length && lines[i].cls === 'diff-add') adds.push(lines[i++]);
    for (let j = 0; j < Math.max(dels.length, adds.length); j++) rows.push([dels[j] || null, adds[j] || null]);
  }
  const cell = (c, side) =>
    c
      ? html`<span class="dv-ln ${side}">${side === 'l' ? c.old : c.new}</span><${Text} text=${c.text} code=${c.code} cls=${c.cls === 'diff-add' ? 'add' : c.cls === 'diff-del' ? 'del' : ''} />`
      : html`<span class="dv-ln ${side} blank"></span><span class="dv-txt blank"></span>`;
  return rows.map(([a, b], k) => html`<div class="dv-srow" key=${k}>${cell(a, 'l')}${cell(b, 'r')}</div>`);
}
