import { html, useState, useEffect, useMemo } from '../lib.mjs';
import { api } from '../api.mjs';
import { showToast } from '../components/toast.mjs';
import { Spinner } from '../components/spinner.mjs';
import { EmptyState } from '../components/empty-state.mjs';
import { StatusBadge } from '../components/status-badge.mjs';
import { TextArea, Select } from '../components/form.mjs';

const TABS = [
  { id: 'all', label: 'All', states: null },
  { id: 'active', label: 'Active', states: ['PLANNING', 'AWAITING_APPROVAL', 'APPROVED', 'IMPLEMENTING', 'TESTING', 'REVIEWING', 'REPAIRING'] },
  { id: 'awaiting', label: 'Awaiting', states: ['AWAITING_APPROVAL'] },
  { id: 'complete', label: 'Complete', states: ['COMPLETE'] },
  { id: 'failed', label: 'Failed', states: ['FAILED'] },
  { id: 'cancelled', label: 'Cancelled', states: ['CANCELLED'] },
];

export function Tasks({ navigate }) {
  const [tasks, setTasks] = useState(null);
  const [projects, setProjects] = useState([]);
  const [tab, setTab] = useState('all');
  const [showForm, setShowForm] = useState(false);
  const [projectId, setProjectId] = useState('');
  const [title, setTitle] = useState('');
  const [saving, setSaving] = useState(false);

  async function load() {
    try {
      const [t, p] = await Promise.all([api.tasks(), api.projects()]);
      setTasks(t);
      setProjects(p);
      setProjectId((cur) => cur || (p[0] && p[0].id) || '');
    } catch (e) {
      showToast(e.message, 'error');
    }
  }

  useEffect(() => {
    load();
  }, []);

  const counts = useMemo(() => {
    if (!tasks) return {};
    const c = {};
    for (const t of TABS) c[t.id] = t.states ? tasks.filter((x) => t.states.includes(x.state)).length : tasks.length;
    return c;
  }, [tasks]);

  const filtered = useMemo(() => {
    if (!tasks) return [];
    const t = TABS.find((x) => x.id === tab);
    return t.states ? tasks.filter((x) => t.states.includes(x.state)) : tasks;
  }, [tasks, tab]);

  async function submit(e) {
    e.preventDefault();
    if (!projectId || !title.trim()) {
      showToast('Project and title are required.', 'error');
      return;
    }
    setSaving(true);
    try {
      const t = await api.createTask(projectId, title.trim());
      showToast('Task created.', 'success');
      setTitle('');
      setShowForm(false);
      await load();
      navigate(`#/tasks/${t.id}`);
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      setSaving(false);
    }
  }

  if (!tasks) return html`<${Spinner} message="Loading tasks..." />`;

  return html`
    <div class="view-tasks">
      <div class="view-toolbar">
        <div class="tabs">
          ${TABS.map(
            (t) => html`
              <button key=${t.id} class="tab ${tab === t.id ? 'active' : ''}" onClick=${() => setTab(t.id)}>
                ${t.label} <span class="tab-count">${counts[t.id] || 0}</span>
              </button>
            `
          )}
        </div>
        <button class="btn" onClick=${() => setShowForm((s) => !s)}>${showForm ? 'Cancel' : '+ New Task'}</button>
      </div>

      ${
        showForm
          ? html`
              <form class="card inline-form" onSubmit=${submit}>
                <${Select}
                  label="Project"
                  value=${projectId}
                  onChange=${setProjectId}
                  options=${projects.map((p) => ({ value: p.id, label: p.name }))}
                  loading=${saving}
                />
                <${TextArea}
                  label="Description"
                  value=${title}
                  onInput=${setTitle}
                  placeholder="Describe what the task should accomplish"
                  rows=${4}
                  loading=${saving}
                  onKeyDown=${(e) => {
                    // Enter inserts a newline in a textarea, so submission needs a modifier.
                    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                      e.preventDefault();
                      submit(e);
                    }
                  }}
                />
                <button class="btn" type="submit" disabled=${saving || !projects.length}>${saving ? 'Creating…' : 'Create task'}</button>
                ${!projects.length ? html`<div class="muted">Add a project first.</div>` : null}
              </form>
            `
          : null
      }

      ${
        filtered.length
          ? html`
              <div class="list">
                ${filtered.map(
                  (t) => html`
                    <div class="list-row clickable" key=${t.id} onClick=${() => navigate(`#/tasks/${t.id}`)}>
                      <div class="list-row-main">
                        <b>${t.title}</b>
                        <span class="muted">${t.project_id} · ${t.created_at ? new Date(t.created_at).toLocaleString() : ''}</span>
                      </div>
                      <${StatusBadge} status=${t.state} />
                    </div>
                  `
                )}
              </div>
            `
          : html`<${EmptyState} message="No tasks in this filter." />`
      }
    </div>
  `;
}
