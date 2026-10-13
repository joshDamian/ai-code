// Small pieces every view uses: status, dialogs, and the pickers for provider, model,
// mode and branch.
import { html, useEffect, useRef } from '../lib.mjs';
import { Select } from './form.mjs';

export const MODES = [
  { value: 'default', label: 'Ask before edits', hint: 'Claude asks before editing files or running commands' },
  { value: 'acceptEdits', label: 'Accept edits', hint: 'File edits go through; commands still ask' },
  { value: 'plan', label: 'Plan', hint: 'Read-only until you approve a plan' },
  { value: 'auto', label: 'Auto', hint: 'A classifier approves routine actions and asks about the rest' },
  { value: 'bypassPermissions', label: 'Bypass permissions', hint: 'Nothing asks. Use in a worktree you can throw away' },
];

export const modeLabel = (m) => MODES.find((x) => x.value === m)?.label || m;

const SESSION_STATUS = {
  running: ['Working', 'badge-info badge-working'],
  waiting: ['Needs you', 'badge-warn'],
  error: ['Error', 'badge-bad'],
  idle: ['Idle', 'badge-neutral'],
};

export function StatusBadge({ status }) {
  const [label, cls] = SESSION_STATUS[status] || SESSION_STATUS.idle;
  return html`<span class="badge ${cls}">${label}</span>`;
}

/** The dot beside a name in a list: what its sessions are doing, worst first. */
export function sessionsStatus(sessions) {
  if (sessions.some((s) => s.status === 'waiting')) return 'waiting';
  if (sessions.some((s) => s.status === 'running')) return 'running';
  if (sessions.some((s) => s.status === 'error')) return 'error';
  return 'idle';
}

export function Dot({ status, title }) {
  return html`<span class="dot dot-${status}" title=${title || SESSION_STATUS[status]?.[0] || ''}></span>`;
}

const TASK_STATE = { active: ['Active', 'badge-good'], merged: ['Merged', 'badge-info'], closed: ['Closed', 'badge-neutral'] };
export function TaskBadge({ state }) {
  const [label, cls] = TASK_STATE[state] || [state, 'badge-neutral'];
  return html`<span class="badge ${cls}">${label}</span>`;
}

/** A modal. Escape and a click outside close it. */
export function Dialog({ title, onClose, children, wide, actions }) {
  const ref = useRef(null);
  useEffect(() => {
    const prev = document.activeElement;
    ref.current?.querySelector('input,textarea,select,button.primary')?.focus();
    return () => prev?.focus?.();
  }, []);
  return html`
    <div class="kbd-overlay confirm-overlay" onClick=${(e) => e.target === e.currentTarget && onClose()}>
      <div
        class="card dialog ${wide ? 'dialog-wide' : ''}"
        role="dialog"
        aria-modal="true"
        ref=${ref}
        onKeyDown=${(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <h2 class="dialog-title">${title}</h2>
        <div class="stack">${children}</div>
        ${actions ? html`<div class="dialog-actions">${actions}</div>` : null}
      </div>
    </div>
  `;
}

/**
 * A panel that rises from the bottom of the screen. On a phone a dialog in the middle
 * is under the keyboard and a row of controls in the header is out of thumb reach; a
 * sheet is where the settings for the thing you are looking at belong, and it closes
 * on the scrim, on Escape, or by dragging the grip down.
 */
export function Sheet({ title, onClose, children }) {
  useEffect(() => {
    const on = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', on, true);
    return () => document.removeEventListener('keydown', on, true);
  }, []);
  return html`
    <div class="sheet-scrim" onClick=${(e) => e.target === e.currentTarget && onClose()}>
      <div class="sheet" role="dialog" aria-modal="true" aria-label=${title}>
        <button class="sheet-grip" type="button" aria-label="Close" onClick=${onClose}></button>
        ${title ? html`<h2 class="sheet-title">${title}</h2>` : null}
        <div class="sheet-body">${children}</div>
      </div>
    </div>
  `;
}

/** Provider, then a model on it. `value` is {providerId, modelId}. */
export function ModelPicker({ providers, value, onChange, compact }) {
  const usable = providers.filter((p) => p.ready || p.id === value.providerId);
  const provider = providers.find((p) => p.id === value.providerId);
  const models = (provider?.models || []).filter((m) => m.enabled || m.id === value.modelId);
  return html`
    <div class="row picker ${compact ? 'compact' : ''}">
      <${Select}
        ariaLabel="Provider"
        inline=${compact}
        value=${value.providerId}
        options=${usable.map((p) => ({ value: p.id, label: p.name }))}
        onChange=${(v) => onChange({ providerId: v, modelId: null })}
      />
      <${Select}
        ariaLabel="Model"
        inline=${compact}
        value=${value.modelId || ''}
        options=${[{ value: '', label: 'Default model' }, ...models.map((m) => ({ value: m.id, label: m.display_name || m.name }))]}
        onChange=${(v) => onChange({ providerId: value.providerId, modelId: v || null })}
      />
    </div>
  `;
}

export const EFFORTS = [
  { value: '', label: 'Default effort' },
  { value: 'low', label: 'Low effort' },
  { value: 'medium', label: 'Medium effort' },
  { value: 'high', label: 'High effort' },
  { value: 'xhigh', label: 'Extra-high effort' },
  { value: 'max', label: 'Max effort' },
];

/** How hard the model thinks. Empty is Claude Code's own default for the model. */
export function EffortPicker({ value, onChange, compact }) {
  return html`<${Select} ariaLabel="Effort" inline=${compact} value=${value || ''} options=${EFFORTS} onChange=${(v) => onChange(v || null)} />`;
}

export function ModePicker({ value, onChange, compact }) {
  return html`<${Select} ariaLabel="Permission mode" inline=${compact} value=${value} options=${MODES.map((m) => ({ value: m.value, label: m.label }))} onChange=${onChange} />`;
}

/** Branches, local first, then the ones only a remote has. */
export function BranchPicker({ branches, value, onChange, label }) {
  const options = branches.map((b) => ({ value: b.name, label: `${b.name}${b.current ? ' (checked out)' : ''}${b.remoteOnly ? ' (remote)' : ''}` }));
  return html`<${Select} label=${label} ariaLabel=${label || 'Branch'} value=${value} options=${options} onChange=${onChange} />`;
}

export function Icon({ name, size = 16 }) {
  const paths = {
    plus: 'M8 3v10M3 8h10',
    branch: 'M5 3v7M5 10a2 2 0 1 0 0 3 2 2 0 0 0 0-3zM5 3a1.5 1.5 0 1 0 0 .1M11 6a1.5 1.5 0 1 0 0-.1M11 6c0 3-6 2-6 4',
    menu: 'M2.5 4h11M2.5 8h11M2.5 12h11',
    stop: 'M4.5 4.5h7v7h-7z',
    send: 'M3 8h9M8.5 4.5 12 8l-3.5 3.5',
    terminal: 'M3 4.5 6 8l-3 3.5M8 11.5h5',
    gear: 'M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4',
    attach: 'M10.5 5 6 9.5a1.4 1.4 0 0 0 2 2l5-5a2.8 2.8 0 0 0-4-4l-5 5a4.2 4.2 0 0 0 6 6l4-4',
    check: 'm3.5 8.5 3 3 6-7',
    x: 'M4 4l8 8M12 4l-8 8',
    back: 'M10 3.5 5.5 8l4.5 4.5',
    refresh: 'M12.5 6A5 5 0 1 0 13 9M12.5 2.5V6H9',
    folder: 'M2 4.5h4l1.5 1.5H14v6.5H2z',
    inbox: 'M2 9h3.2l1 1.8h3.6l1-1.8H14M2 9l1.7-5h8.6L14 9v4.5H2z',
    list: 'M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01',
    send2: 'M2 8h10M8 4l4 4-4 4',
    down: 'M8 3v9M4.5 8.5 8 12l3.5-3.5',
    chevron: 'm4.5 6.5 3.5 3.5 3.5-3.5',
    mic: 'M8 2.5a2 2 0 0 0-2 2v3.5a2 2 0 1 0 4 0V4.5a2 2 0 0 0-2-2zM3.5 7.5v.5a4.5 4.5 0 0 0 9 0v-.5M8 12.5V14',
  };
  return html`<svg class="ic" width=${size} height=${size} viewBox="0 0 16 16" aria-hidden="true"><path d=${paths[name] || ''} /></svg>`;
}
