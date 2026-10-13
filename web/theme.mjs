// Which look the app wears. A theme is a block of tokens in themes.css, switched on by
// `data-theme` on <html>; Classic is the absence of one, the look app.css declares.
//
// The choice is this device's, kept in localStorage: a phone used at night and a desk
// used by day are different places to read. index.html applies it before the first
// paint, so a reload never flashes Classic first; this module is what changes it.
//
// No imports on purpose: tests/themes.test.mjs loads THEMES in node to check that the
// picker offers exactly what the stylesheet defines.

/** The colours each picker card previews: page, card, accent, and the ink its lines are
 * drawn in. `chrome` is the browser's own bar (theme-color) while the theme is on. */
export const THEMES = [
  { id: 'classic', name: 'Classic', dark: true, bg: '#0a0c10', surface: '#11151b', accent: '#9fb9ff', ink: '#8e9aaa', chrome: '#0a0c10' },
  { id: 'quiet-temple', name: 'Quiet Temple', dark: false, bg: '#f7f8fb', surface: '#ffffff', accent: '#5a6882', ink: '#696e7d', chrome: '#f2f3f6' },
  { id: 'coastal', name: 'Coastal', dark: false, bg: '#e9f6fb', surface: '#f9fdff', accent: '#0e7398', ink: '#4f6f7b', chrome: '#e4f1f6' },
  { id: 'notebook', name: 'Notebook', dark: false, bg: '#fbf6ea', surface: '#fffdf7', accent: '#2f6bb2', ink: '#645f52', chrome: '#f6f1e5' },
  { id: 'garden', name: 'Garden', dark: false, bg: '#f1efe4', surface: '#fdfbf2', accent: '#2f5a42', ink: '#4a5e50', chrome: '#eceadf' },
  { id: 'solarpunk', name: 'Solarpunk', dark: false, bg: '#edf7e8', surface: '#f8fff5', accent: '#257a4a', ink: '#547152', chrome: '#e8f2e3' },
  { id: 'soft-clay', name: 'Soft Clay', dark: false, bg: '#ede9ff', surface: '#f8f6ff', accent: '#694fdb', ink: '#6b6186', chrome: '#e8e4fa' },
  { id: 'chronicle', name: 'Chronicle', dark: false, bg: '#efe3c3', surface: '#f6edd2', accent: '#9f1d20', ink: '#6a5329', chrome: '#eadebf' },
  { id: 'chrome', name: 'Chrome', dark: true, bg: '#07090f', surface: '#2d313c', accent: '#6ee7ff', ink: '#acb4cd', chrome: '#12151d' },
  { id: 'neon-grid', name: 'Neon Grid', dark: true, bg: '#050812', surface: '#0c1326', accent: '#2afadf', ink: '#8eb9c6', chrome: '#070b18' },
  { id: 'deco-noir', name: 'Deco Noir', dark: true, bg: '#0e0e11', surface: '#161619', accent: '#dfc07a', ink: '#b5a681', chrome: '#101013' },
];

export const THEME_KEY = 'bench:theme';
/** Fired on window when the theme changes, for anything that paints outside CSS (the
 * terminal draws to a canvas, so it has to be told). */
export const THEME_EVENT = 'bench:theme';

export const themeOf = (id) => THEMES.find((t) => t.id === id) || THEMES[0];

export function currentTheme() {
  return themeOf(document.documentElement.dataset.theme || 'classic');
}

/** The colour the browser paints its own bar in, so a phone's status bar matches. */
function syncChrome(theme) {
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme.chrome);
}

export function setTheme(id) {
  const theme = themeOf(id);
  if (theme.id === 'classic') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme.id;
  try {
    if (theme.id === 'classic') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, JSON.stringify(theme.id));
  } catch {
    /* private mode: the theme still applies, it just is not remembered */
  }
  syncChrome(theme);
  window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: theme }));
}

/** Any theme but the one already on. */
export function surpriseTheme() {
  const others = THEMES.filter((t) => t.id !== currentTheme().id);
  setTheme(others[Math.floor(Math.random() * others.length)].id);
}

if (typeof document !== 'undefined') syncChrome(currentTheme());
