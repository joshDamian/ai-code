// A "⋯" button and the actions behind it. For the occasional and the destructive:
// what a page does now and then, kept off the row where its main action is so a
// click aimed at one cannot land on the other.
//
// Escape is handled on the element and marked handled, so the window listeners that
// close the layer above it leave that layer alone.
import { html, useState, useEffect, useRef } from '../lib.mjs';

export function MoreMenu({ items, label = 'More actions', size = 36 }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const list = (items || []).filter(Boolean);

  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);

  if (!list.length) return null;

  return html`
    <div
      class="ss-menu-wrap"
      ref=${ref}
      onKeyDown=${(e) => {
        if (e.key === 'Escape' && open) {
          e.preventDefault();
          setOpen(false);
        }
      }}
    >
      <button
        class="btn secondary ss-icon-btn"
        style=${`width:${size}px;height:${size}px`}
        type="button"
        aria-label=${label}
        aria-haspopup="menu"
        aria-expanded=${open}
        onClick=${() => setOpen((v) => !v)}
      >
        <svg class="ss-ic" viewBox="0 0 16 16" aria-hidden="true"><circle cx="4" cy="8" r=".9" /><circle cx="8" cy="8" r=".9" /><circle cx="12" cy="8" r=".9" /></svg>
      </button>
      ${open
        ? html`
            <div class="ss-menu" role="menu">
              ${list.map(
                (it) => html`
                  <button
                    role="menuitem"
                    type="button"
                    key=${it.label}
                    class=${it.danger ? 'danger' : ''}
                    disabled=${it.disabled}
                    onClick=${() => {
                      setOpen(false);
                      it.onSelect();
                    }}
                  >
                    ${it.label}
                  </button>
                `
              )}
            </div>
          `
        : null}
    </div>
  `;
}
