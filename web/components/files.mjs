// Files a session mentions, made reachable from the transcript. A path in a turn that
// the server says is a file under the session's directory becomes Open and Download,
// or, for an image, the image itself. Nothing here decides what a file is: the type,
// and whether it may be opened at all, come from the server's stat, never the name.
import { html, createContext, useContext, useEffect, useRef, useState } from '../lib.mjs';
import { api } from '../api.mjs';

/** @typedef {{path:string, mime:string, size:number, open:boolean}} FileInfo */
/** @typedef {{sessionId:string, files:Map<string, FileInfo>}} FilesValue */

/** @type {import('preact').Context<FilesValue|null>} */
export const FilesContext = createContext(/** @type {FilesValue|null} */ (null));

// Anything that could be a path: absolute, ./ or ../, or a bare name with an extension.
// It is generous on purpose - the server's stat is what decides - but a token with
// neither a slash nor an extension is a word, not a file, and is not asked about.
const PATH = /(?:~?\/|\.{1,2}\/)?[\w@+.-]*[\w@+-](?:\/[\w@+.-]+)*/g;

/** @param {string} text @returns {string[]} */
export function findPaths(text) {
  const out = [];
  for (const m of String(text || '').matchAll(PATH)) {
    const t = m[0].replace(/[.]+$/, '');
    if (t.length < 3 || t.length > 1024 || t.startsWith('~') || /^\d[\d.]*$/.test(t)) continue;
    if (t.includes('/') || /\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(t)) out.push(t);
  }
  return out;
}

/** @param {string} sessionId @param {FileInfo} f @param {boolean} [download] */
export const fileUrl = (sessionId, f, download = false) => `/api/sessions/${encodeURIComponent(sessionId)}/files?path=${encodeURIComponent(f.path)}${download ? '&download=1' : ''}`;

const isImage = (/** @type {FileInfo} */ f) => f.open && f.mime.startsWith('image/');

/**
 * Stats every path the events mention, newest first, in batches the server takes. A
 * long session mentions many hundreds of candidates, most of them words, so a path is
 * asked about once - and again, if it was not a file, only while the turn naming it is
 * still going: Claude often names a file before the step that writes it.
 * @param {string} sessionId @param {any[]} events
 * @returns {Map<string, FileInfo>}
 */
export function useSessionFiles(sessionId, events) {
  const [files, setFiles] = useState(() => new Map());
  const asked = useRef(new Map());
  useEffect(() => {
    setFiles(new Map());
    asked.current = new Map();
  }, [sessionId]);
  useEffect(() => {
    const done = events.filter((e) => e.kind === 'tool_result' || e.kind === 'result').length;
    let turn = events.length;
    while (turn > 0 && events[turn - 1].kind !== 'user') turn--;
    const want = new Set();
    for (let i = events.length - 1; i >= 0; i--) for (const p of eventPaths(events[i])) want.add(p);
    const current = new Set(events.slice(turn).flatMap(eventPaths));
    const fresh = [...want].filter((p) => !files.has(p) && (!asked.current.has(p) || (current.has(p) && asked.current.get(p) !== done)));
    for (const p of fresh) asked.current.set(p, done);
    for (let i = 0; i < fresh.length; i += 500) {
      api
        .fileStat(sessionId, fresh.slice(i, i + 500))
        .then((found) => {
          const hits = Object.entries(found || {});
          if (hits.length) setFiles((m) => new Map([...m, ...hits]));
        })
        .catch(() => {});
    }
  }, [sessionId, events]);
  return files;
}

/** The paths one event could be talking about. @param {any} e */
function eventPaths(e) {
  const d = e.data || {};
  if (e.kind === 'assistant') {
    return (d.content || []).flatMap((/** @type {any} */ b) => {
      if (b.type === 'text') return findPaths(b.text);
      if (b.type === 'tool_use' && b.input?.file_path) return [String(b.input.file_path)];
      return [];
    });
  }
  if (e.kind === 'tool_result') return (d.results || []).flatMap((/** @type {any} */ r) => findPaths(typeof r.content === 'string' ? r.content : JSON.stringify(r.content)));
  return [];
}

/** What a session file offers: the image itself, or Open, and always Download. */
export function FileActions({ token }) {
  const ctx = useContext(FilesContext);
  const f = ctx?.files.get(token);
  if (!ctx || !f) return null;
  return html`<span class="file-acts">
    ${f.open && !isImage(f) ? html`<a href=${fileUrl(ctx.sessionId, f)} target="_blank" rel="noopener noreferrer">Open</a>` : null}
    <a href=${fileUrl(ctx.sessionId, f, true)} download>Download</a>
  </span>`;
}

/** An image the session made, drawn in the turn, opening full size in a tab. */
export function FileImage({ token }) {
  const ctx = useContext(FilesContext);
  const f = ctx?.files.get(token);
  if (!ctx || !f || !isImage(f)) return null;
  return html`<a class="file-image" href=${fileUrl(ctx.sessionId, f)} target="_blank" rel="noopener noreferrer"><img src=${fileUrl(ctx.sessionId, f)} alt=${token} loading="lazy" /></a>`;
}

/** Plain text - a tool's output - with each file it names followed by what it offers. */
export function LinkedText({ text }) {
  const ctx = useContext(FilesContext);
  if (!ctx?.files.size) return text;
  const parts = [];
  let at = 0;
  for (const m of String(text).matchAll(PATH)) {
    const t = m[0].replace(/[.]+$/, '');
    if (!ctx.files.has(t) || m.index === undefined) continue;
    parts.push(text.slice(at, m.index + t.length), html`<${FileActions} token=${t} />`);
    at = m.index + t.length;
  }
  if (!parts.length) return text;
  parts.push(text.slice(at));
  return parts;
}

/**
 * The same, for markdown already sanitised and in the page. Links are built here, after
 * DOMPurify, so its hook that sends every link to a new tab never sees a Download -
 * which in a new tab would flash a blank page before saving. Text in a fenced block
 * is left alone; a path written in `code` or in prose is linked. An image is drawn below
 * the paragraph that names it, since one dropped mid-sentence breaks the line apart.
 * @param {HTMLElement} root @param {FilesValue|null} ctx
 */
export function linkFiles(root, ctx) {
  if (!ctx?.files.size) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest('pre, a, .file-acts') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(/** @type {Text} */ (walker.currentNode));
  for (const node of nodes) {
    const text = node.data;
    const hits = [...text.matchAll(PATH)].map((m) => ({ i: m.index ?? 0, t: m[0].replace(/[.]+$/, '') })).filter((h) => ctx.files.has(h.t));
    if (!hits.length) continue;
    // Inside `code`, only a span that is the path and nothing else is linked, with its
    // actions after the span: `bin/install --service` is a command, not a file to hand over.
    const code = node.parentElement?.tagName === 'CODE' ? node.parentElement : null;
    if (code) {
      if (hits.length === 1 && hits[0].t === code.textContent?.trim()) {
        const f = /** @type {FileInfo} */ (ctx.files.get(hits[0].t));
        code.after(actionsNode(ctx, f, hits[0].t));
        if (isImage(f)) blockOf(root, code)?.after(imageNode(ctx, f, hits[0].t));
      }
      continue;
    }
    const frag = document.createDocumentFragment();
    let at = 0;
    for (const { i, t } of hits) {
      frag.append(text.slice(at, i + t.length), actionsNode(ctx, /** @type {FileInfo} */ (ctx.files.get(t)), t));
      at = i + t.length;
    }
    frag.append(text.slice(at));
    const block = blockOf(root, node);
    node.replaceWith(frag);
    for (const { t } of [...hits].reverse()) {
      const f = /** @type {FileInfo} */ (ctx.files.get(t));
      if (isImage(f) && block) block.after(imageNode(ctx, f, t));
    }
  }
}

/** The top-level block - paragraph, list, heading - a text node sits in. @param {HTMLElement} root @param {Node} node */
function blockOf(root, node) {
  let el = node.parentElement;
  while (el && el.parentElement !== root) el = el.parentElement;
  return el;
}

/** @param {FilesValue} ctx @param {FileInfo} f @param {string} token */
function imageNode(ctx, f, token) {
  const a = document.createElement('a');
  a.className = 'file-image';
  a.href = fileUrl(ctx.sessionId, f);
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  const img = document.createElement('img');
  img.src = a.href;
  img.alt = token;
  img.loading = 'lazy';
  a.append(img);
  return a;
}

/** @param {FilesValue} ctx @param {FileInfo} f @param {string} token */
function actionsNode(ctx, f, token) {
  const span = document.createElement('span');
  span.className = 'file-acts';
  const link = (/** @type {string} */ label, /** @type {boolean} */ download) => {
    const a = document.createElement('a');
    a.href = fileUrl(ctx.sessionId, f, download);
    a.textContent = label;
    if (download) a.setAttribute('download', '');
    else {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    }
    return a;
  };
  if (f.open && !isImage(f)) span.append(link('Open', false));
  span.append(link('Download', true));
  return span;
}
