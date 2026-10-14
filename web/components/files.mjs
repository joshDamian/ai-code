// What a session made, reachable from the transcript. A path in a reply that the server
// says is an artifact - a file the session produced or was given, not source it is
// working on - gets a card under the paragraph naming it: an image as itself, anything
// else as its name, type and size, with View where the browser can show it and
// Download always. Viewing happens in an overlay over the session, never a new tab: in
// the installed app a tab is a separate window to find and close.
//
// Nothing here decides what a file is. Its type, whether it may be shown and whether
// it counts as an artifact all come from the server's stat, never from the name.
import { html, createContext, useContext, useEffect, useRef, useState } from '../lib.mjs';
import { api } from '../api.mjs';
import { Markdown } from './markdown.mjs';

/** @typedef {{path:string, name:string, mime:string, size:number, open:boolean, kind:string, artifact:boolean}} FileInfo */
/** @typedef {{sessionId:string, files:Map<string, FileInfo>, view:(f: FileInfo) => void}} FilesValue */

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

const isImage = (/** @type {FileInfo} */ f) => f.open && f.kind === 'image';
/** Whether the viewer can show it. Everything else is only downloaded. */
export const viewable = (/** @type {FileInfo} */ f) => f.open && ['image', 'pdf', 'text'].includes(f.kind);

/** @param {number} n */
function fileSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** "PDF · 4 KB", "APK · 38.2 MB": the extension says more to a person than a MIME type. @param {FileInfo} f */
const fileMeta = (f) => `${(f.name.includes('.') ? f.name.split('.').pop() || '' : f.kind).toUpperCase()} · ${fileSize(f.size)}`;

/** Saves a file without leaving the page: a same-tab link with `download` never navigates. @param {string} sessionId @param {FileInfo} f */
export function download(sessionId, f) {
  const a = document.createElement('a');
  a.href = fileUrl(sessionId, f, true);
  a.download = f.name;
  document.body.append(a);
  a.click();
  a.remove();
}

// 16px line icons, as markup, so the cards built into rendered markdown and the ones
// drawn by components look the same.
const ICONS = {
  download: 'M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10',
  view: 'M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
  external: 'M9.5 2.5h4v4M13.5 2.5 8 8M11.5 9.5v4h-9v-9h4',
  close: 'M4 4l8 8M12 4l-8 8',
  file: 'M4 1.5h5.5L12.5 4.5v10h-8.5zM9.5 1.5v3h3',
  doc: 'M4 1.5h5.5L12.5 4.5v10h-8.5zM9.5 1.5v3h3M6 8h4.5M6 10.5h4.5',
  archive: 'M2.5 4.5h11v9h-11zM2 2.5h12v2H2zM6.5 7h3',
  media: 'M4.5 3v10l8.5-5z',
  image: 'M2.5 3h11v10h-11zM2.5 11l3.5-3.5 3 3 2-2 2.5 2.5M10.5 6a1 1 0 1 0 0 .1',
};
/** @param {keyof typeof ICONS} name */
const svg = (name) => `<svg class="ic" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="${ICONS[name]}"/></svg>`;
/** @param {string} kind @returns {keyof typeof ICONS} */
const kindIcon = (kind) => (/** @type {Record<string, keyof typeof ICONS>} */ ({ image: 'image', pdf: 'doc', text: 'doc', document: 'doc', archive: 'archive', media: 'media' })[kind] || 'file');
const Svg = ({ name }) => html`<span class="ic-wrap" dangerouslySetInnerHTML=${{ __html: svg(name) }} />`;

/**
 * Stats every path the replies name, newest first, in batches the server takes. A long
 * session mentions many hundreds of candidates, most of them words, so a path is asked
 * about once - and again, if it was not a file, only while the turn naming it is still
 * going: Claude often names a file before the step that writes it.
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

// What Claude says and the files it writes. A tool's output is left out: a build log
// names hundreds of paths, and what was built is what the reply points at.
/** @param {any} e */
function eventPaths(e) {
  if (e.kind !== 'assistant') return [];
  return (e.data?.content || []).flatMap((/** @type {any} */ b) => {
    if (b.type === 'text') return findPaths(b.text);
    if (b.type === 'tool_use' && b.name === 'Write' && b.input?.file_path) return [String(b.input.file_path)];
    return [];
  });
}

// -- in rendered markdown ------------------------------------------------------------------

/**
 * Turns the artifacts a reply names into references and cards, after the markdown is
 * sanitised and in the page. Built here rather than through DOMPurify, whose hook sends
 * every link to a new tab. A fenced block is left alone; inside `code`, only a span that
 * is the path and nothing else counts - `bin/install --service` is a command.
 * @param {HTMLElement} root @param {FilesValue|null} ctx
 */
export function linkFiles(root, ctx) {
  if (!ctx?.files.size) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest('pre, a, button, .file-card') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(/** @type {Text} */ (walker.currentNode));
  /** @type {Map<Element, FileInfo[]>} cards to add, by the block they follow */
  const cards = new Map();
  const shown = new Set();
  const card = (/** @type {Node} */ at, /** @type {FileInfo} */ f) => {
    const block = blockOf(root, at);
    if (!block || shown.has(f.path)) return;
    shown.add(f.path);
    cards.set(block, [...(cards.get(block) || []), f]);
  };
  for (const node of nodes) {
    const text = node.data;
    const hits = [...text.matchAll(PATH)]
      .map((m) => ({ i: m.index ?? 0, t: m[0].replace(/[.]+$/, '') }))
      .filter((h) => ctx.files.get(h.t)?.artifact);
    if (!hits.length) continue;
    const code = node.parentElement?.tagName === 'CODE' ? node.parentElement : null;
    if (code) {
      if (hits.length !== 1 || hits[0].t !== code.textContent?.trim()) continue;
      const f = /** @type {FileInfo} */ (ctx.files.get(hits[0].t));
      const ref = refNode(ctx, f);
      code.replaceWith(ref);
      ref.append(code);
      card(ref, f);
      continue;
    }
    const frag = document.createDocumentFragment();
    let at = 0;
    for (const { i, t } of hits) {
      const f = /** @type {FileInfo} */ (ctx.files.get(t));
      const ref = refNode(ctx, f);
      ref.textContent = t;
      frag.append(text.slice(at, i), ref);
      at = i + t.length;
    }
    frag.append(text.slice(at));
    const anchor = node.parentElement || root;
    node.replaceWith(frag);
    for (const { t } of hits) card(anchor, /** @type {FileInfo} */ (ctx.files.get(t)));
  }
  for (const [block, list] of cards) {
    const row = document.createElement('div');
    row.className = 'file-cards';
    for (const f of list) row.append(cardNode(ctx, f));
    block.after(row);
  }
}

/** The top-level block - paragraph, list, heading - a node sits in. @param {HTMLElement} root @param {Node} node */
function blockOf(root, node) {
  let el = node instanceof Element ? node : node.parentElement;
  while (el && el.parentElement !== root) el = el.parentElement;
  return el;
}

/** Opens the viewer for what it can show and saves the rest. @param {FilesValue} ctx @param {FileInfo} f */
const activate = (ctx, f) => (viewable(f) ? ctx.view(f) : download(ctx.sessionId, f));

/** The path in the sentence, made the thing to tap. @param {FilesValue} ctx @param {FileInfo} f */
function refNode(ctx, f) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'file-ref';
  b.title = viewable(f) ? `View ${f.name}` : `Download ${f.name}`;
  b.addEventListener('click', () => activate(ctx, f));
  return b;
}

/** @param {FilesValue} ctx @param {FileInfo} f */
function cardNode(ctx, f) {
  const el = document.createElement('div');
  if (isImage(f)) {
    el.className = 'file-card file-card-image';
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'file-thumb';
    open.title = `View ${f.name}`;
    open.addEventListener('click', () => ctx.view(f));
    const img = document.createElement('img');
    img.src = fileUrl(ctx.sessionId, f);
    img.alt = f.name;
    img.loading = 'lazy';
    open.append(img);
    el.append(open);
  } else el.className = 'file-card';
  const info = document.createElement('div');
  info.className = 'file-card-info';
  info.innerHTML = `${isImage(f) ? '' : `<span class="file-card-icon">${svg(kindIcon(f.kind))}</span>`}<span class="file-card-text"><span class="file-card-name"></span><span class="file-card-meta"></span></span>`;
  /** @type {HTMLElement} */ (info.querySelector('.file-card-name')).textContent = f.name;
  /** @type {HTMLElement} */ (info.querySelector('.file-card-meta')).textContent = fileMeta(f);
  info.title = f.path;
  const acts = document.createElement('span');
  acts.className = 'file-card-acts';
  const btn = (/** @type {keyof typeof ICONS} */ icon, /** @type {string} */ label, /** @type {() => void} */ fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'file-btn';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.innerHTML = svg(icon);
    b.addEventListener('click', fn);
    return b;
  };
  if (viewable(f) && !isImage(f)) acts.append(btn('view', `View ${f.name}`, () => ctx.view(f)));
  acts.append(btn('download', `Download ${f.name}`, () => download(ctx.sessionId, f)));
  info.append(acts);
  el.append(info);
  return el;
}

// -- in components -------------------------------------------------------------------------

/** View and Download for the file a Write made, beside its header. Nothing for source. */
export function FileButtons({ token }) {
  const ctx = useContext(FilesContext);
  const f = ctx?.files.get(token);
  if (!ctx || !f?.artifact) return null;
  return html`<span class="file-card-acts">
    ${viewable(f) ? html`<button type="button" class="file-btn" title=${`View ${f.name}`} aria-label=${`View ${f.name}`} onClick=${() => ctx.view(f)}><${Svg} name="view" /></button>` : null}
    <button type="button" class="file-btn" title=${`Download ${f.name}`} aria-label=${`Download ${f.name}`} onClick=${() => download(ctx.sessionId, f)}><${Svg} name="download" /></button>
  </span>`;
}

/** An image a Write made, under its header. */
export function FileThumb({ token }) {
  const ctx = useContext(FilesContext);
  const f = ctx?.files.get(token);
  if (!ctx || !f?.artifact || !isImage(f)) return null;
  return html`<button type="button" class="file-thumb tool-thumb" title=${`View ${f.name}`} onClick=${() => ctx.view(f)}><img src=${fileUrl(ctx.sessionId, f)} alt=${f.name} loading="lazy" /></button>`;
}

// -- the viewer ----------------------------------------------------------------------------

// Text past this is not drawn: a 50 MB log is downloaded, not scrolled in a <pre>.
const TEXT_PREVIEW = 2 * 1024 * 1024;

/**
 * Which file the viewer shows, with the history entry that lets the back gesture - the
 * only way back on a phone - close it rather than leave the session.
 * @returns {[FileInfo|null, (f: FileInfo) => void, () => void]}
 */
export function useViewer() {
  const [file, setFile] = useState(/** @type {FileInfo|null} */ (null));
  useEffect(() => {
    const onPop = () => setFile(null);
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, []);
  const open = (/** @type {FileInfo} */ f) => {
    if (!history.state?.benchViewer) history.pushState({ ...history.state, benchViewer: true }, '');
    setFile(f);
  };
  const close = () => (history.state?.benchViewer ? history.back() : setFile(null));
  return [file, open, close];
}

export function FileViewer({ sessionId, file: f, onClose }) {
  const [text, setText] = useState(/** @type {string|null} */ (null));
  const url = fileUrl(sessionId, f);
  const isHtml = /^text\/html/.test(f.mime);
  const asText = f.kind === 'text' && !isHtml;
  const isMd = asText && /\.(md|markdown|mdx)$/i.test(f.name);
  const [raw, setRaw] = useState(false);
  useEffect(() => {
    const onKey = (/** @type {KeyboardEvent} */ e) => e.key === 'Escape' && onClose();
    addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, []);
  useEffect(() => {
    setText(null);
    if (!asText || f.size > TEXT_PREVIEW) return;
    let live = true;
    fetch(url, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((t) => {
        if (!live) return;
        if (/json/.test(f.mime)) {
          try {
            t = JSON.stringify(JSON.parse(t), null, 2);
          } catch {}
        }
        setText(t);
      })
      .catch(() => live && setText(''));
    return () => {
      live = false;
    };
  }, [url]);

  let body;
  if (f.kind === 'image') body = html`<img class="viewer-image" src=${url} alt=${f.name} />`;
  else if (f.kind === 'pdf') body = html`<iframe class="viewer-frame" src=${url} title=${f.name}></iframe>`;
  // The page is already sandboxed by the server; the frame's own sandbox keeps it so.
  else if (isHtml) body = html`<iframe class="viewer-frame" sandbox="" src=${url} title=${f.name}></iframe>`;
  else if (f.size > TEXT_PREVIEW) body = html`<div class="viewer-note">Too large to preview here. <button type="button" class="link-btn" onClick=${() => download(sessionId, f)}>Download it</button>.</div>`;
  else body = text === null ? html`<div class="viewer-note">Loading…</div>` : isMd && !raw ? html`<${Markdown} text=${text} className="md viewer-text viewer-md" />` : html`<pre class="viewer-text">${text}</pre>`;

  return html`
    <div class="viewer ${f.kind === 'image' ? 'viewer-dark' : ''}" role="dialog" aria-modal="true" aria-label=${f.name}>
      <header class="viewer-bar">
        <span class="file-card-icon">${html`<${Svg} name=${kindIcon(f.kind)} />`}</span>
        <span class="file-card-text">
          <span class="file-card-name">${f.name}</span>
          <span class="file-card-meta">${fileMeta(f)}</span>
        </span>
        <span class="viewer-gap"></span>
        ${isMd ? html`<button type="button" class="file-btn" title=${raw ? 'Show rendered' : 'Show source'} aria-pressed=${raw} onClick=${() => setRaw(!raw)}>${raw ? 'Rendered' : 'Source'}</button>` : null}
        <a class="file-btn" href=${url} target="_blank" rel="noopener noreferrer" title="Open in browser" aria-label="Open in browser"><${Svg} name="external" /></a>
        <button type="button" class="file-btn" title="Download" aria-label="Download" onClick=${() => download(sessionId, f)}><${Svg} name="download" /></button>
        <button type="button" class="file-btn" title="Close (Esc)" aria-label="Close" onClick=${onClose}><${Svg} name="close" /></button>
      </header>
      <div class="viewer-body" onClick=${(e) => e.target === e.currentTarget && onClose()}>${body}</div>
    </div>
  `;
}
