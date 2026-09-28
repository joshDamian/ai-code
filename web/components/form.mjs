// Inline form fields, styled to match the dark theme. All support a
// `loading` prop that disables the control and dims it while an async
// operation is in flight (the operation itself shows a Spinner elsewhere).
import { html } from '../lib.mjs';

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

export function Select({ label, value, onChange, options, disabled, loading, inline }) {
  return html`
    <label class="field ${inline ? 'inline' : ''}">
      ${label ? html`<span class="field-label">${label}</span>` : null}
      <select class="input" value=${value} disabled=${disabled || loading} onChange=${(e) => onChange(e.target.value)}>
        ${options.map((o) => html`<option value=${o.value} key=${o.value}>${o.label}</option>`)}
      </select>
    </label>
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
