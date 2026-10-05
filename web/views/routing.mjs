import { html, useState, useEffect } from '../lib.mjs';
import { api } from '../api.mjs';
import { showToast } from '../components/toast.mjs';
import { Spinner } from '../components/spinner.mjs';
import { Select } from '../components/form.mjs';

const ROLES = ['planner', 'implementer', 'reviewer', 'repair'];
const ROLE_CAPABILITY = { planner: 'planning', implementer: 'coding', reviewer: 'review', repair: 'repair' };
const STRATEGIES = ['quality', 'balanced', 'speed', 'cost'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

export function Routing() {
  const [routing, setRouting] = useState(null);
  const [models, setModels] = useState([]);
  const [draft, setDraft] = useState({});
  const [saving, setSaving] = useState(false);

  async function load() {
    try {
      const [r, p] = await Promise.all([api.routing(), api.providers()]);
      setRouting(r);
      setModels(p.models);
      setDraft(r);
    } catch (e) {
      showToast(e.message, 'error');
    }
  }

  useEffect(() => {
    load();
  }, []);

  function updateRole(role, patch) {
    setDraft((d) => ({ ...d, [role]: { ...(d[role] || {}), ...patch } }));
  }

  async function save() {
    setSaving(true);
    try {
      await api.saveRouting(draft);
      showToast('Routing saved.', 'success');
      await load();
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      setSaving(false);
    }
  }

  if (!routing) return html`<${Spinner} message="Loading routing policy..." />`;

  const dirty = JSON.stringify(draft) !== JSON.stringify(routing);

  return html`
    <div class="view-routing stack">
      <div class="view-toolbar">
        <p class="view-lead">Which model each role in the pipeline runs on, and where it goes when that model fails. Automatic picks the best enabled model for the strategy.</p>
      </div>
      ${ROLES.map((role) => html`<${RoleCard} key=${role} role=${role} policy=${draft[role] || {}} models=${models} onChange=${(p) => updateRole(role, p)} />`)}
      ${
        dirty
          ? html`
              <div class="save-bar" role="region" aria-label="Unsaved changes">
                <span>You have unsaved routing changes.</span>
                <button class="btn secondary" type="button" disabled=${saving} onClick=${() => setDraft(routing)}>Discard</button>
                <button class="btn primary" type="button" disabled=${saving} onClick=${save}>${saving ? 'Saving…' : 'Save routing'}</button>
              </div>
            `
          : null
      }
    </div>
  `;
}

// What each role does, in the words a person choosing a model for it needs.
const ROLE_ABOUT = {
  planner: 'Reads the task and the code, and writes the plan you approve.',
  implementer: 'Carries out the approved plan in the task’s worktree.',
  reviewer: 'Reads the diff and judges it against the plan.',
  repair: 'Fixes what the tests or the review found.',
};

function Seg({ value, options, onChange, label }) {
  return html`
    <div class="seg" role="radiogroup" aria-label=${label}>
      ${options.map(
        (o) => html`
          <button type="button" role="radio" aria-checked=${value === o ? 'true' : 'false'} class="seg-btn ${value === o ? 'active' : ''}" onClick=${() => onChange(o)} key=${o}>
            ${o[0].toUpperCase() + o.slice(1)}
          </button>
        `
      )}
    </div>
  `;
}

function RoleCard({ role, policy, models, onChange }) {
  const cap = ROLE_CAPABILITY[role];
  const eligible = models.filter((m) => m.enabled && m.provider_id !== 'mock' && (m.capabilities || []).includes(cap));
  const preferred = (policy.preferred && policy.preferred[0]) || '';
  const fallback = policy.fallback || [];

  const strategy = policy.strategy || 'balanced';
  // What Automatic resolves to under the strategy on screen, saved or not. Without
  // it the toggle is a word whose effect can only be found in a run log.
  const [picks, setPicks] = useState(null);
  useEffect(() => {
    let live = true;
    api.routingPreview(role, strategy).then((r) => live && setPicks(r), () => live && setPicks(null));
    return () => {
      live = false;
    };
  }, [role, strategy]);

  const option = (m) => ({ value: m.id, label: m.displayName || m.name, hint: m.provider_id });
  const modelOptions = [{ value: '', label: 'Automatic' }, ...eligible.map(option)];
  const fallbackOptions = [{ value: '', label: 'None' }, ...eligible.map(option)];

  return html`
    <section class="card role-card">
      <div class="role-card-head">
        <div class="role-card-title">
          <h2>${role[0].toUpperCase() + role.slice(1)}</h2>
          <p class="muted">${ROLE_ABOUT[role]}</p>
        </div>
        <${Seg} label=${`${role} strategy`} value=${strategy} options=${STRATEGIES} onChange=${(v) => onChange({ strategy: v })} />
      </div>
      ${picks?.length
        ? html`<p class="muted role-picks">
            Automatic picks <b>${picks[0].name}</b>${picks.length > 1 ? html`, then ${picks.slice(1).map((m) => m.name).join(', then ')}` : null}${preferred ? html` · your preferred model comes first` : null}
          </p>`
        : null}
      <div class="role-chain">
        <${Select} label="Preferred model" value=${preferred} onChange=${(v) => onChange({ preferred: v ? [v] : [] })} options=${modelOptions} />
        <span class="role-chain-arrow" aria-hidden="true">→</span>
        <${Select}
          label="Then"
          value=${fallback[0] || ''}
          onChange=${(v) => onChange({ fallback: [v, fallback[1] || ''].filter(Boolean) })}
          options=${fallbackOptions}
        />
        <span class="role-chain-arrow" aria-hidden="true">→</span>
        <${Select}
          label="Then"
          value=${fallback[1] || ''}
          onChange=${(v) => onChange({ fallback: [fallback[0] || '', v].filter(Boolean) })}
          options=${fallbackOptions}
          disabled=${!fallback[0]}
        />
      </div>
      <div class="role-knobs">
        <div class="field">
          <span class="field-label">Effort</span>
          <${Seg} label=${`${role} effort`} value=${policy.effort || 'medium'} options=${EFFORTS} onChange=${(v) => onChange({ effort: v })} />
        </div>
        <label class="field role-timeout">
          <span class="field-label">Timeout</span>
          <span class="input-suffix">
            <input class="input" type="number" min="0" value=${policy.timeout || ''} placeholder="600" onInput=${(e) => onChange({ timeout: Number(e.target.value) || undefined })} />
            <span>seconds</span>
          </span>
        </label>
      </div>
    </section>
  `;
}
