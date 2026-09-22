import { html, useState, useEffect } from '../lib.mjs';
import { api } from '../api.mjs';
import { showToast } from '../components/toast.mjs';
import { Spinner } from '../components/spinner.mjs';
import { Select, TextInput } from '../components/form.mjs';

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

  return html`
    <div class="view-routing">
      <div class="view-toolbar">
        <button class="btn" disabled=${saving} onClick=${save}>${saving ? 'Saving…' : 'Save routing'}</button>
      </div>
      <div class="stack">
        ${ROLES.map((role) => html`<${RoleCard} key=${role} role=${role} policy=${draft[role] || {}} models=${models} onChange=${(p) => updateRole(role, p)} />`)}
      </div>
    </div>
  `;
}

function RoleCard({ role, policy, models, onChange }) {
  const cap = ROLE_CAPABILITY[role];
  const eligible = models.filter((m) => m.enabled && m.provider_id !== 'mock' && (m.capabilities || []).includes(cap));
  const preferred = (policy.preferred && policy.preferred[0]) || '';
  const fallback = policy.fallback || [];

  const label = (m) => `${m.displayName || m.name} — ${m.provider_id}`;
  const modelOptions = [{ value: '', label: 'Automatic' }, ...eligible.map((m) => ({ value: m.id, label: label(m) }))];
  const fallbackOptions = [{ value: '', label: 'None' }, ...eligible.map((m) => ({ value: m.id, label: label(m) }))];

  return html`
    <div class="card">
      <div class="provider-card-head">
        <div>
          <b>${role[0].toUpperCase() + role.slice(1)}</b>
          <div class="muted">${policy.strategy || 'balanced'} routing</div>
        </div>
        <${Select}
          value=${policy.strategy || 'balanced'}
          onChange=${(v) => onChange({ strategy: v })}
          options=${STRATEGIES.map((s) => ({ value: s, label: s[0].toUpperCase() + s.slice(1) }))}
        />
      </div>
      <div class="grid3">
        <${Select} label="Preferred model" value=${preferred} onChange=${(v) => onChange({ preferred: v ? [v] : [] })} options=${modelOptions} />
        <${Select}
          label="Fallback 1"
          value=${fallback[0] || ''}
          onChange=${(v) => onChange({ fallback: [v, fallback[1] || ''].filter(Boolean) })}
          options=${fallbackOptions}
        />
        <${Select}
          label="Fallback 2"
          value=${fallback[1] || ''}
          onChange=${(v) => onChange({ fallback: [fallback[0] || '', v].filter(Boolean) })}
          options=${fallbackOptions}
        />
        <${Select} label="Effort" value=${policy.effort || 'medium'} onChange=${(v) => onChange({ effort: v })} options=${EFFORTS.map((x) => ({ value: x, label: x }))} />
        <${TextInput}
          label="Timeout (seconds)"
          type="number"
          value=${policy.timeout || ''}
          onInput=${(v) => onChange({ timeout: Number(v) || undefined })}
        />
      </div>
    </div>
  `;
}
