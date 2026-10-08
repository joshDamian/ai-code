// Model output rendered as markdown. This is the only file in the dashboard that
// turns untrusted text into HTML, so the sanitiser lives here and nowhere else -
// every other component goes through htm and gets escaping for free.
//
// After the sanitised HTML is in the page, fenced code blocks are dressed up in
// place: a ```mermaid block becomes a diagram and a block in a language highlight.js
// knows gets syntax colour. Both libraries are fetched the first time a block needs
// them and never before, and a block they cannot handle - a library that failed to
// load, a diagram that does not parse, a language with no grammar - stays the plain
// code block it already was.
import { html, useRef, useEffect } from '../lib.mjs';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { copyText, COPIED_MS, COPY_ICON, COPIED_ICON } from './copy.mjs';

// A link in a plan points at the outside world. Following it in the dashboard's
// own tab navigates away from a task mid-review with no way back, and rel=noopener
// drops the window.opener handle it would otherwise hand the destination.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.hasAttribute('href')) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

// Past this many lines in one block, highlighting costs more than it gives back: a
// pasted log is read by scrolling, not by colour.
const HIGHLIGHT_LINES = 3000;

let hljsLoad = null;
function loadHighlighter() {
  hljsLoad ||= import('highlight.js').then((m) => m.default).catch(() => null);
  return hljsLoad;
}

// Mermaid's own palette is drawn from the dashboard's tokens, read once at load so
// the colours have one source. securityLevel 'strict' escapes labels and drops click
// handlers and links. The classic look keeps the dashboard's flat strokes; mermaid
// 12's default look adds gradients and shadows. `secure` lists the settings a diagram's %%{init}%% directive may not override: on
// top of mermaid's defaults, the theme and its CSS, so a diagram cannot restyle
// itself out of the palette or bring stylesheet text of its own.
let mermaidLoad = null;
function loadMermaid() {
  mermaidLoad ||= import('mermaid')
    .then(({ default: mermaid }) => {
      const css = getComputedStyle(document.documentElement);
      const token = (name) => css.getPropertyValue(name).trim();
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        suppressErrorRendering: true,
        secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges', 'theme', 'themeVariables', 'themeCSS', 'fontFamily', 'altFontFamily'],
        theme: 'base',
        look: 'classic',
        fontFamily: token('--font-ui'),
        themeVariables: {
          darkMode: true,
          background: token('--surface-1'),
          fontFamily: token('--font-ui'),
          primaryColor: token('--surface-3'),
          primaryTextColor: token('--text'),
          primaryBorderColor: token('--accent-dim'),
          nodeBorder: token('--accent-dim'),
          secondaryColor: token('--surface-2'),
          tertiaryColor: token('--surface-2'),
          lineColor: token('--muted'),
          edgeLabelBackground: token('--surface-1'),
          textColor: token('--text'),
          noteBkgColor: token('--surface-2'),
          noteTextColor: token('--text'),
          noteBorderColor: token('--line'),
        },
      });
      return mermaid;
    })
    .catch(() => null);
  return mermaidLoad;
}

// The language marked wrote onto a fenced block, from its `language-<lang>` class.
function blockLanguage(code) {
  const cls = [...code.classList].find((c) => c.startsWith('language-'));
  return cls ? cls.slice('language-'.length).toLowerCase() : null;
}

let diagramSeq = 0;

// Mermaid's SVG goes through the sanitiser like everything else. A diagram is the one
// place SVG is let in. Its labels are HTML inside <foreignObject>, and that HTML is
// held to the same allow-list as a plan's own markup. Labels drawn as SVG <text>
// instead would need no HTML, but mermaid 12 no longer centres them in state and use
// case shapes.
async function renderDiagram(pre, code) {
  const mermaid = await loadMermaid();
  if (!mermaid || !pre.isConnected) return;
  const id = `md-diagram-${++diagramSeq}`;
  let svg;
  try {
    ({ svg } = await mermaid.render(id, code.textContent));
  } catch {
    // A diagram that does not parse stays readable as its source. Mermaid can leave
    // its scratch container behind when it throws.
    document.getElementById(`d${id}`)?.remove();
    return;
  }
  if (!pre.isConnected) return;
  const box = document.createElement('div');
  box.className = 'md-diagram';
  box.innerHTML = DOMPurify.sanitize(svg, {
    USE_PROFILES: { html: true, svg: true, svgFilters: true },
    ADD_TAGS: ['foreignObject'],
    HTML_INTEGRATION_POINTS: { foreignobject: true },
  });
  pre.replaceWith(box);
}

// Every fenced block, diagram or not, gets a Copy button in its corner. The block is
// wrapped so the button stays put while a wide block scrolls sideways under it, and it
// copies the source as written: a diagram's mermaid text, not its drawing.
function addCopyButton(pre, code) {
  const source = code.textContent.replace(/\n$/, '');
  const wrap = document.createElement('div');
  wrap.className = 'md-block';
  pre.replaceWith(wrap);
  wrap.append(pre);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'copy-btn md-copy';
  btn.setAttribute('aria-label', 'Copy code');
  btn.title = 'Copy code';
  btn.innerHTML = COPY_ICON;
  let reset = null;
  btn.addEventListener('click', async () => {
    if (!(await copyText(source))) return;
    btn.innerHTML = COPIED_ICON;
    btn.setAttribute('aria-label', 'Copied');
    clearTimeout(reset);
    reset = setTimeout(() => {
      btn.innerHTML = COPY_ICON;
      btn.setAttribute('aria-label', 'Copy code');
    }, COPIED_MS);
  });
  wrap.append(btn);
}

async function highlightBlock(code, lang) {
  if (code.textContent.split('\n').length > HIGHLIGHT_LINES) return;
  const hljs = await loadHighlighter();
  if (!hljs || !hljs.getLanguage(lang) || !code.isConnected) return;
  // highlight.js escapes the source it is given and adds only <span class> markup.
  code.innerHTML = hljs.highlight(code.textContent, { language: lang, ignoreIllegals: true }).value;
  code.classList.add('hljs');
}

// `marked` passes raw HTML through, which is the point of the sanitiser rather
// than a mode to enable: the allow-list is DOMPurify's, and USE_PROFILES keeps it
// to HTML so SVG and MathML are not reachable from a plan.
//
// The effect runs whenever the HTML changes, which is when Preact has replaced the
// container's contents. Work still in flight from an earlier version finds its block
// gone from the page and drops itself, so a streamed answer never gets a diagram or
// colour from text it no longer shows.
export function Markdown({ text, className = 'md' }) {
  const ref = useRef(null);
  const clean = text ? DOMPurify.sanitize(marked.parse(text), { USE_PROFILES: { html: true } }) : '';
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    for (const code of root.querySelectorAll('pre > code')) {
      const lang = blockLanguage(code);
      addCopyButton(code.parentElement, code);
      if (lang === 'mermaid') renderDiagram(code.parentElement, code);
      else if (lang) highlightBlock(code, lang);
    }
  }, [clean]);
  if (!text) return null;
  return html`<div ref=${ref} class=${className} dangerouslySetInnerHTML=${{ __html: clean }} />`;
}
