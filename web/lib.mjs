// Shared Preact + HTM setup. Every module imports its `html` tag and hook
// functions from here instead of talking to the CDN URLs directly, so the
// CDN version is pinned in exactly one place.
import { h, render, Fragment, createContext } from 'preact';
import htm from 'htm';

export const html = htm.bind(h);
export { h, render, Fragment, createContext };
export * from 'preact/hooks';

// The CLI, the TUI and the dashboard render the same events, so they render them
// with the same functions. `ai-code/format` is mapped to src/format.mjs by the
// import map in index.html and served from there by src/server.mjs.
export { describeEvent, formatEvent, formatDuration, formatTokens, formatCost, formatState, bodyKind, diffLines, diffSides, unifiedDiff } from 'ai-code/format';

// Fuzzy match, scored. Every query character must appear in order, so "ovw"
// finds Overview and "rt" finds Routing; a character that starts a word, or that
// runs on from the previous match, counts for more, which is what keeps the
// intended row on top when several contain the same letters. Typos are not
// tolerated - a wrong character is a miss, not a near miss - because a palette
// that answers "Prmviders" with Providers also answers "P" with everything.
//
// `hits` are the matched offsets, which the row tints so a fuzzy hit reads as a
// match rather than as a row that happens to be there.
//
// Lives here rather than in the palette it was written for because the task
// picker matches titles the same way, and a component-to-component import for
// one function is a dependency neither component wants.
export function fuzzy(text, q) {
  const hay = text.toLowerCase();
  // Lowercasing that changes length (İ -> i̇) would put every offset off by one.
  // Such a label still matches exactly; it just gets no highlight.
  if (hay.length !== text.length) return hay.includes(q) ? { score: 0, hits: [] } : null;
  const hits = [];
  let score = 0;
  let from = 0;
  let prev = -1;
  let streak = 0;
  for (const ch of q) {
    const at = hay.indexOf(ch, from);
    if (at === -1) return null;
    streak = at === prev + 1 ? streak + 1 : 0;
    score += 1 + (at === 0 || !/[a-z0-9]/.test(hay[at - 1]) ? 4 : 0) + streak * 2;
    hits.push(at);
    prev = at;
    from = at + 1;
  }
  // Front-weighted: a hit that starts early in the label beats the same letters
  // buried in a long title.
  return { score: score - prev * 0.1, hits };
}
