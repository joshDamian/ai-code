import { html, useState, useEffect } from '../lib.mjs';
import { api } from '../api.mjs';
import { showToast } from '../components/toast.mjs';
import { Spinner } from '../components/spinner.mjs';
import { EmptyState } from '../components/empty-state.mjs';
import { TextInput } from '../components/form.mjs';

export function Projects() {
  const [projects, setProjects] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [saving, setSaving] = useState(false);

  async function load() {
    try {
      setProjects(await api.projects());
    } catch (e) {
      showToast(e.message, 'error');
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function submit(e) {
    e.preventDefault();
    if (!name.trim() || !path.trim()) {
      showToast('Name and path are required.', 'error');
      return;
    }
    setSaving(true);
    try {
      await api.createProject(name.trim(), path.trim());
      showToast('Project added.', 'success');
      setName('');
      setPath('');
      setShowForm(false);
      await load();
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      setSaving(false);
    }
  }

  if (!projects) return html`<${Spinner} message="Loading projects..." />`;

  return html`
    <div class="view-projects">
      <div class="view-toolbar">
        <button class="btn" onClick=${() => setShowForm((s) => !s)}>${showForm ? 'Cancel' : '+ Project'}</button>
      </div>

      ${
        showForm
          ? html`
              <form class="card inline-form" onSubmit=${submit}>
                <${TextInput} label="Name" value=${name} onInput=${setName} placeholder="my-service" loading=${saving} />
                <${TextInput}
                  label="Absolute path"
                  value=${path}
                  onInput=${setPath}
                  placeholder="/Users/you/code/my-service"
                  loading=${saving}
                />
                <button class="btn" type="submit" disabled=${saving}>${saving ? 'Adding…' : 'Add project'}</button>
              </form>
            `
          : null
      }

      ${
        projects.length
          ? html`
              <div class="list">
                ${projects.map(
                  (p) => html`
                    <div class="list-row" key=${p.id}>
                      <div class="list-row-main">
                        <b>${p.name}</b>
                        <span class="muted">${p.path} ${p.language ? `· ${p.language}` : ''} ${p.framework ? `· ${p.framework}` : ''}</span>
                      </div>
                      <span class="badge badge-neutral">${Object.keys(p.commands || {}).length} commands</span>
                    </div>
                  `
                )}
              </div>
            `
          : html`<${EmptyState} message="No projects registered." actionLabel="+ Project" onAction=${() => setShowForm(true)} />`
      }
    </div>
  `;
}
