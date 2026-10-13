// The theme picker: a small pill that names the current look, and a panel of previews
// that opens from it. Picking applies at once - the panel is drawn in the theme it is
// choosing, so the preview is the app itself and there is no Apply to press.
//
// The pill can sit anywhere (the sidebar's header, the Settings page); the panel is
// drawn by ThemePickerHost at the root, the way ConfirmHost is. Drawn inside the
// sidebar it would be clipped by its scroll box, and on a phone the sidebar is a
// transformed drawer, which a fixed panel would be positioned against and slide with.
import { html, useState, useEffect, useRef } from '../lib.mjs';
import { THEMES, THEME_EVENT, currentTheme, setTheme, surpriseTheme } from '../theme.mjs';

/** The open panel's anchor, or null. One panel at a time across every pill. */
let anchor = null;
const listeners = new Set();
const emit = () => listeners.forEach((fn) => fn(anchor));

/** The current theme, re-read whenever it changes. */
function useTheme() {
  const [theme, set] = useState(currentTheme);
  useEffect(() => {
    const on = () => set(currentTheme());
    window.addEventListener(THEME_EVENT, on);
    return () => window.removeEventListener(THEME_EVENT, on);
  }, []);
  return theme;
}

/** The pill. `align` says which edge of the pill the panel lines up with. */
export function ThemeTrigger({ align = 'start' }) {
  const theme = useTheme();
  const ref = useRef(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const on = (a) => setOpen(!!a && a.el === ref.current);
    listeners.add(on);
    return () => listeners.delete(on);
  }, []);
  const toggle = () => {
    anchor = open ? null : { el: ref.current, align };
    emit();
  };
  return html`
    <button class="tp-trigger" type="button" ref=${ref} aria-haspopup="dialog" aria-expanded=${open} title="Change the theme" onClick=${toggle}>
      <span class="tp-dots" aria-hidden="true"><span></span><span></span><span></span></span>
      <span class="tp-current">${theme.name}</span>
    </button>
  `;
}

const PANEL_W = 352;
const GAP = 8;

/** Where the panel goes: under the pill, or over it when there is no room below. */
function place(a) {
  const r = a.el.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  const width = Math.min(PANEL_W, vw - 2 * GAP);
  const left = a.align === 'end' ? r.right - width : r.left;
  const pos = { width, left: Math.max(GAP, Math.min(left, vw - width - GAP)) };
  const below = vh - r.bottom - GAP * 2;
  const above = r.top - GAP * 2;
  if (below >= 320 || below >= above) return { ...pos, top: r.bottom + GAP, maxHeight: below };
  return { ...pos, bottom: vh - r.top + GAP, maxHeight: above };
}

export function ThemePickerHost() {
  const [a, setA] = useState(anchor);
  const theme = useTheme();
  const panel = useRef(null);

  useEffect(() => {
    listeners.add(setA);
    return () => listeners.delete(setA);
  }, []);

  useEffect(() => {
    if (!a) return undefined;
    const close = (refocus) => {
      anchor = null;
      emit();
      if (refocus) a.el?.focus?.();
    };
    const onDown = (e) => {
      if (panel.current?.contains(e.target) || a.el.contains(e.target)) return;
      close(false);
    };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      close(true);
    };
    // The page moving under the panel would leave it pointing at nothing.
    const onMove = () => close(false);
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onMove);
    window.addEventListener('hashchange', onMove);
    panel.current?.querySelector('.tp-card[aria-pressed="true"]')?.focus();
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('hashchange', onMove);
    };
  }, [a]);

  if (!a || !a.el?.isConnected) return null;
  const p = place(a);
  const style = Object.entries(p)
    .map(([k, v]) => `${k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}:${v}px`)
    .join(';');

  return html`
    <div class="tp-panel" role="dialog" aria-label="Theme" ref=${panel} style=${style}>
      <div class="tp-head">
        <span class="tp-title">Theme</span>
        <button class="tp-shuffle" type="button" onClick=${surpriseTheme}>Surprise me</button>
      </div>
      <div class="tp-grid" role="list">
        ${THEMES.map(
          (t, i) => html`
            <button
              class="tp-card"
              type="button"
              role="listitem"
              key=${t.id}
              aria-pressed=${t.id === theme.id}
              onClick=${() => setTheme(t.id)}
              style=${`--i:${i};--p-bg:${t.bg};--p-sf:${t.surface};--p-ac:${t.accent};--p-tx:${t.ink}`}
            >
              <span class="tp-preview" aria-hidden="true">
                <span class="tp-preview-card"><span class="tp-line"></span><span class="tp-line"></span><span class="tp-accent"></span></span>
              </span>
              <span class="tp-label">${t.name}</span>
            </button>
          `
        )}
      </div>
    </div>
  `;
}
