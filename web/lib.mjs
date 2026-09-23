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
