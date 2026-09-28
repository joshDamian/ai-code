// A row of tabs that announces itself as one.
//
// A strip of buttons that swap a panel below them looks exactly like tabs and is
// not one, to anybody who is not looking at it. The roles say what the strip is,
// `aria-selected` says which one is current, and the arrow keys move between them
// - because a tab is not a link and Tab is how you leave the strip, not how you
// walk it. That is the whole convention, and it is the difference between seven
// buttons and one control.
import { html, useRef, useEffect } from '../lib.mjs';

// `id` doubles as the panel's, so the two ends of `aria-controls` are derived
// from one name rather than kept in step by hand.
//
// Only the current tab is in the tab order (`tabIndex` below). Without that, Tab
// walks through all seven before it reaches the panel they control.
export function Tabs({ tabs, value, onChange, label }) {
  const refs = useRef({});
  const stripRef = useRef(null);

  // The open tab is kept in view when the strip is narrower than its tabs, which on a
  // phone it is. Scrolled on the strip itself: scrollIntoView would also move the
  // page, and a tab switch is not a reason to jump the reader somewhere else.
  useEffect(() => {
    const strip = stripRef.current;
    const el = refs.current[value];
    if (!strip || !el || strip.scrollWidth <= strip.clientWidth) return;
    const left = el.offsetLeft - strip.offsetLeft;
    const right = left + el.offsetWidth;
    if (left < strip.scrollLeft + 24) strip.scrollLeft = Math.max(0, left - 24);
    else if (right > strip.scrollLeft + strip.clientWidth - 40) strip.scrollLeft = right - strip.clientWidth + 40;
  }, [value]);

  function move(to) {
    onChange(to);
    refs.current[to]?.focus();
  }

  function onKeyDown(e) {
    const i = tabs.findIndex((t) => t.id === value);
    if (i === -1) return;
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      move(tabs[(i + 1) % tabs.length].id);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      move(tabs[(i - 1 + tabs.length) % tabs.length].id);
    } else if (e.key === 'Home') {
      e.preventDefault();
      move(tabs[0].id);
    } else if (e.key === 'End') {
      e.preventDefault();
      move(tabs[tabs.length - 1].id);
    }
  }

  return html`
    <div class="tabs" role="tablist" aria-label=${label} onKeyDown=${onKeyDown} ref=${stripRef}>
      ${tabs.map(
        (t) => html`
          <button
            key=${t.id}
            ref=${(el) => {
              refs.current[t.id] = el;
            }}
            class="tab ${value === t.id ? 'active' : ''}"
            type="button"
            role="tab"
            id=${`tab-${t.id}`}
            aria-selected=${value === t.id ? 'true' : 'false'}
            aria-controls=${`panel-${t.id}`}
            tabIndex=${value === t.id ? 0 : -1}
            onClick=${() => onChange(t.id)}
          >
            ${t.label}${' '}
            ${t.done
              ? html`<svg class="tab-done" viewBox="0 0 16 16" role="img" aria-label="Done"><path d="m3.5 8.5 3 3 6-7" /></svg>`
              : null}
            ${t.dot ? html`<span class="tab-dot" role="img" aria-label=${t.dotLabel || 'Updated'}></span>` : null}
            ${t.count == null ? null : html`${' '}<span class="tab-count">${t.count}</span>`}
          </button>
        `
      )}
    </div>
  `;
}

// The panel the tabs control. `tabId` is the id of the tab that is showing it, so
// a screen reader announces the pair together.
export function TabPanel({ tabId, children }) {
  return html`
    <div class="tab-content" role="tabpanel" id=${`panel-${tabId}`} aria-labelledby=${`tab-${tabId}`} tabIndex="0">
      ${children}
    </div>
  `;
}
