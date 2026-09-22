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

export function Select({ label, value, onChange, options, disabled, loading }) {
  return html`
    <label class="field">
      ${label ? html`<span class="field-label">${label}</span>` : null}
      <select class="input" value=${value} disabled=${disabled || loading} onChange=${(e) => onChange(e.target.value)}>
        ${options.map((o) => html`<option value=${o.value} key=${o.value}>${o.label}</option>`)}
      </select>
    </label>
  `;
}

export function TextArea({ label, value, onInput, placeholder, disabled, loading, rows = 6 }) {
  return html`
    <label class="field">
      ${label ? html`<span class="field-label">${label}</span>` : null}
      <textarea
        class="input"
        rows=${rows}
        value=${value}
        placeholder=${placeholder || ''}
        disabled=${disabled || loading}
        onInput=${(e) => onInput(e.target.value)}
      ></textarea>
    </label>
  `;
}
