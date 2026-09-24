import { html, useState, useEffect } from '../lib.mjs';
import { api } from '../api.mjs';
import { showToast } from '../components/toast.mjs';
import { Spinner } from '../components/spinner.mjs';
import { EmptyState } from '../components/empty-state.mjs';
import { TextInput, TextArea } from '../components/form.mjs';

// The two ways in, and they are not the same thing. `add` names a repository that
// already exists - the path is realpath'd and refused if it is not one. `idea`
// starts from an idea note: nothing exists yet, the folder and the repository are
// created when the drafted spec is approved, and the drafting is a chat turn.
const MODES = { add: 'add', idea: 'idea' };

export function Projects({ navigate }) {
  const [projects, setProjects] = useState(null);
  const [mode, setMode] = useState(null);
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [idea, setIdea] = useState('');
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

  function reset() {
    setName('');
    setPath('');
    setIdea('');
    setMode(null);
  }

  async function submit(e) {
    e.preventDefault();
    if (mode === MODES.idea) {
      if (!idea.trim()) {
        showToast('An idea note is required.', 'error');
        return;
      }
      setSaving(true);
      try {
        const started = await api.startIntake(idea.trim(), name.trim());
        reset();
        // The drafting turn is a chat turn, so the conversation is where it is
        // watched - and where the spec and the first tasks appear once it answers.
        navigate(`#/chat/${started.session.id}`);
      } catch (e) {
        showToast(e.message, 'error');
      } finally {
        setSaving(false);
      }
      return;
    }
    if (!name.trim() || !path.trim()) {
      showToast('Name and path are required.', 'error');
      return;
    }
    setSaving(true);
    try {
      await api.createProject(name.trim(), path.trim());
      showToast('Project added.', 'success');
      reset();
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
        <div class="list-row-side">
          <button class="btn" onClick=${() => setMode((m) => (m === MODES.add ? null : MODES.add))}>${mode === MODES.add ? 'Cancel' : '+ Project'}</button>
          <button class="btn secondary" onClick=${() => setMode((m) => (m === MODES.idea ? null : MODES.idea))}>
            ${mode === MODES.idea ? 'Cancel' : 'From an idea'}
          </button>
        </div>
      </div>

      ${
        mode === MODES.add
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
        mode === MODES.idea
          ? html`
              <form class="card inline-form" onSubmit=${submit}>
                <${TextArea}
                  label="The idea, in your own words"
                  value=${idea}
                  onInput=${setIdea}
                  rows=${8}
                  placeholder="A small CLI that renames files in bulk: a dry run, then a confirmation, then the moves."
                  loading=${saving}
                />
                <${TextInput} label="Project name (optional)" value=${name} onInput=${setName} placeholder="bulk-renamer" loading=${saving} />
                <p class="muted">
                  Nothing is created yet. The draft pass proposes a spec and a first set of tasks; the folder and the repository are created when you approve
                  the spec, and each task is created when you approve it.
                </p>
                <button class="btn" type="submit" disabled=${saving}>${saving ? 'Drafting…' : 'Draft the project'}</button>
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
                    <div class="list-row clickable" key=${p.id} onClick=${() => navigate(`#/project/${p.id}`)}>
                      <div class="list-row-main">
                        <b>${p.name}</b>
                        <span class="muted">${p.path} ${p.language ? `· ${p.language}` : ''} ${p.framework ? `· ${p.framework}` : ''}</span>
                      </div>
                      <div class="list-row-side">
                        ${p.drafts?.length ? html`<span class="badge badge-warn">${p.drafts.length} drafted</span>` : null}
                        ${p.spec ? html`<span class="badge badge-good">spec</span>` : p.idea ? html`<span class="badge badge-warn">idea only</span>` : html`<span class="badge badge-neutral">no spec</span>`}
                        <span class="badge badge-neutral">${Object.keys(p.commands || {}).length} commands</span>
                      </div>
                    </div>
                  `
                )}
              </div>
            `
          : html`<${EmptyState} message="No projects registered." actionLabel="+ Project" onAction=${() => setMode(MODES.add)} />`
      }
    </div>
  `;
}
