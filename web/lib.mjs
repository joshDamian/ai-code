// Shared Preact + HTM setup. Every module imports `html` and the hooks from here.
import { h, render, Fragment, createContext } from 'preact';
import htm from 'htm';

export const html = htm.bind(h);
export { h, render, Fragment, createContext };
export * from 'preact/hooks';
export { formatDuration, formatTokens, formatCost, formatBytes, formatWhen, diffLines, diffSides, diffFiles, diffLanguage, splitHighlighted } from './format.mjs';

// Per-browser conveniences: what was typed and not sent, which panel was open. Storage
// can throw or come back empty at any time, so nothing here is load-bearing.
export function recall(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

export function remember(key, value) {
  try {
    if (value === undefined || value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* the page works without it */
  }
}

// The last two folders of a path, which is how a person names one they did not type.
export function shortDir(p) {
  const parts = String(p || '').split('/').filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : String(p || '');
}

export const isTouch = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

// Fuzzy match, scored: every query character in order, word starts and runs count more.
export function fuzzy(text, q) {
  const hay = text.toLowerCase();
  let score = 0;
  let from = 0;
  let prev = -1;
  for (const ch of q.toLowerCase()) {
    const at = hay.indexOf(ch, from);
    if (at === -1) return null;
    score += 1 + (at === 0 || !/[a-z0-9]/.test(hay[at - 1]) ? 4 : 0) + (at === prev + 1 ? 2 : 0);
    prev = at;
    from = at + 1;
  }
  return score - prev * 0.1;
}
