// Inline form fields, styled to match the dark theme. All support a
// `loading` prop that disables the control and dims it while an async
// operation is in flight (the operation itself shows a Spinner elsewhere).
import { html, useState, useRef, useEffect, useMemo } from '../lib.mjs';
import { useAnchor } from './anchor.mjs';

export function TextInput({ label, value, onInput, placeholder, disabled, loading, type = 'text' }) {
  return html`
    <label class="field">
      ${label ? html`<span class="field-label">${label}</span>` : null}
      <input
        type=${type}
        class="input"
        value=${value}
        placeholder=${placeholder || ''}
        disabled=${disabled || loading}
        onInput=${(e) => onInput(e.target.value)}
      />
    </label>
  `;
}

// A select that looks like the rest of the dashboard. The native control draws the
// operating system's own chevron and, worse, its own menu - a light, system-font list
// dropped over a dark page - so the one control that picks between options was the
// one that looked borrowed.
//
// The keyboard contract is the native one, because that is what hands already know:
// Space, Enter or an arrow opens it, the arrows move, Home and End jump, a letter
// jumps to the next option starting with it, Enter or Space picks, and Escape or Tab
// closes without picking. Escape is handled on the element and marked handled, so
// the window listeners that close the layer above it leave that layer alone.
export function Select({ label, value, onChange, options, disabled, loading, inline, size, ariaLabel, className = '' }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrapRef = useRef(null);
  const triggerRef = useRef(null);
  const listRef = useRef(null);
  const id = useMemo(() => `sel-${Math.random().toString(36).slice(2, 9)}`, []);
  const off = disabled || loading;
  const index = options.findIndex((o) => String(o.value) === String(value));
  const current = options[index] || options[0];

  const openList = (at = index < 0 ? 0 : index) => {
    if (off || !options.length) return;
    setActive(at);
    setOpen(true);
    // A click does not focus a button in Safari, and the keys that move through the
    // list are read from the focused trigger - so focus is put there, not assumed.
    triggerRef.current?.focus();
  };
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };
  const pick = (i) => {
    const o = options[i];
    if (!o || o.disabled) return;
    close();
    // A string, as the native control's `e.target.value` always was.
    if (String(o.value) !== String(value)) onChange(String(o.value));
  };

  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) close(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);

  // Placed from the trigger rather than inside it, so no scrolling ancestor clips it.
  const place = useAnchor(triggerRef, open, Math.min(280, options.length * 36 + 12));

  useEffect(() => {
    if (!open) return;
    listRef.current?.children[active]?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const onKeyDown = (e) => {
    const last = options.length - 1;
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault();
        openList(e.key === 'ArrowUp' ? Math.max(0, index - 1) : undefined);
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'Tab') {
      close(false);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(last, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActive(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActive(last);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      pick(active);
    } else if (e.key.length === 1 && /\S/.test(e.key)) {
      const k = e.key.toLowerCase();
      const order = options.map((_, i) => (active + 1 + i) % options.length);
      const hit = order.find((i) => String(options[i].label).toLowerCase().startsWith(k));
      if (hit != null) setActive(hit);
    }
  };

  return html`
    <div
      class="field select-field ${inline ? 'inline' : ''} ${className}"
      ref=${wrapRef}
      onKeyDown=${onKeyDown}
      onFocusOut=${(e) => {
        if (open && !wrapRef.current?.contains(e.relatedTarget)) close(false);
      }}
    >
      ${label ? html`<span class="field-label" id=${`${id}-label`}>${label}</span>` : null}
      <div class="select ${size ? `select-${size}` : ''} ${open ? 'open' : ''}">
        <button
          ref=${triggerRef}
          type="button"
          class="input select-trigger"
          disabled=${off}
          role="combobox"
          aria-haspopup="listbox"
          aria-activedescendant=${open ? `${id}-o${active}` : null}
          aria-expanded=${open}
          aria-controls=${`${id}-list`}
          aria-labelledby=${label ? `${id}-label ${id}-value` : null}
          aria-label=${label ? null : ariaLabel || null}
          onClick=${() => (open ? close() : openList())}
        >
          <span class="select-value" id=${`${id}-value`}>${current ? current.label : ''}</span>
          <svg class="select-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
        </button>
        ${open
          ? html`
              <ul class="select-list" style=${place || { visibility: 'hidden' }} role="listbox" id=${`${id}-list`} ref=${listRef} tabIndex="-1">
                ${options.map(
                  (o, i) => html`
                    <li
                      key=${String(o.value)}
                      id=${`${id}-o${i}`}
                      role="option"
                      aria-selected=${i === index}
                      aria-disabled=${o.disabled ? 'true' : null}
                      class="select-option ${i === active ? 'active' : ''} ${i === index ? 'selected' : ''}"
                      onPointerDown=${(e) => e.preventDefault()}
                      onPointerEnter=${() => setActive(i)}
                      onClick=${() => pick(i)}
                    >
                      <span class="select-option-label">${o.label}</span>
                      ${o.hint ? html`<span class="select-option-hint">${o.hint}</span>` : null}
                      ${i === index ? html`<svg class="select-check" viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7" /></svg>` : null}
                    </li>
                  `
                )}
              </ul>
            `
          : null}
      </div>
    </div>
  `;
}

// The DOM node reaches the caller as `inputRef`, never as `ref`: Preact strips
// `ref` off the props it hands a component, so a `ref` written here is always
// undefined and the caller's ref is set to this component's own instance - which
// has no `focus`, and throws the moment anyone calls one.
export function TextArea({ label, value, onInput, onKeyDown, placeholder, disabled, loading, rows = 6, autofocus, inputRef }) {
  return html`
    <label class="field">
      ${label ? html`<span class="field-label">${label}</span>` : null}
      <textarea
        ref=${inputRef}
        class="input"
        rows=${rows}
        value=${value}
        placeholder=${placeholder || ''}
        disabled=${disabled || loading}
        onInput=${(e) => onInput(e.target.value)}
        onKeyDown=${onKeyDown}
        autofocus=${autofocus}
      ></textarea>
    </label>
  `;
}

// An on/off control that acts the moment it is pressed. A switch is for a setting
// that takes effect at once; a choice that waits for a Save button is a checkbox,
// and a switch that waits is a switch that lies about the state it shows.
export function Toggle({ checked, onChange, disabled, label, hideLabel }) {
  return html`
    <label class="toggle ${disabled ? 'disabled' : ''}">
      <button
        type="button"
        role="switch"
        class="toggle-track ${checked ? 'on' : ''}"
        aria-checked=${checked ? 'true' : 'false'}
        aria-label=${hideLabel ? label : null}
        disabled=${disabled}
        onClick=${() => onChange(!checked)}
      >
        <span class="toggle-thumb"></span>
      </button>
      ${label && !hideLabel ? html`<span class="toggle-label">${label}</span>` : null}
    </label>
  `;
}
