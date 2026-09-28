import { html, useState, useEffect, shortDir } from '../lib.mjs';
import { api } from '../api.mjs';
import { showToast } from '../components/toast.mjs';
import { Spinner } from '../components/spinner.mjs';
import { EmptyState } from '../components/empty-state.mjs';
import { TextInput, TextArea } from '../components/form.mjs';
import { Time } from '../components/time.mjs';

// A task counts as active from the moment planning starts until it settles, and as
// waiting when the next move is a person's. The rest are resting and are not counted.
const IDLE = new Set(['CREATED', 'COMPLETE', 'FAILED', 'CANCELLED']);
const WAITING = new Set(['AWAITING_APPROVAL', 'AWAITING_DECISION']);

// The two ways in, and they are not the same thing. `add` names a repository that
// already exists - the path is realpath'd and refused if it is not one. `idea`
// starts from an idea note: nothing exists yet, the folder and the repository are
// created when the drafted spec is approved, and the drafting is a chat turn.
const MODES = { add: 'add', idea: 'idea' };

export function Projects({ navigate, openForm }) {
  const [projects, setProjects] = useState(null);
  const [tasks, setTasks] = useState(null);
  const [mode, setMode] = useState(null);
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [idea, setIdea] = useState('');
  const [saving, setSaving] = useState(false);

  async function load() {
    try {
      // Tasks ride along so each card can say what is happening in it, which is the
      // question a person opening this page is asking - not what its path is.
      const [list, all] = await Promise.all([api.projects(), api.tasks().catch(() => [])]);
      setTasks(all);
      setProjects(list);
    } catch (e) {
      showToast(e.message, 'error');
    }
  }

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    if (openForm) setMode(MODES.add);
  }, [openForm]);

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

  const close = html`<button type="button" class="icon-btn" aria-label="Close" onClick=${reset}>✕</button>`;

  return html`
    <div class="view-projects">
      <div class="view-toolbar">
        <p class="view-lead">Repositories the pipeline may plan, change and review.</p>
        <div class="row">
          <button class="btn secondary" type="button" onClick=${() => setMode((m) => (m === MODES.idea ? null : MODES.idea))} aria-expanded=${mode === MODES.idea}>
            From an idea
          </button>
          <button class="btn primary" type="button" onClick=${() => setMode((m) => (m === MODES.add ? null : MODES.add))} aria-expanded=${mode === MODES.add}>
            New project
          </button>
        </div>
      </div>

      ${
        mode === MODES.add
          ? html`
              <form class="card inline-form project-form" onSubmit=${submit}>
                <div class="inline-form-head"><h3>Add a repository</h3>${close}</div>
                <div class="inline-form-grid">
                  <${TextInput} label="Name" value=${name} onInput=${setName} placeholder="my-service" loading=${saving} />
                  <${TextInput} label="Absolute path" value=${path} onInput=${setPath} placeholder="/Users/you/code/my-service" loading=${saving} />
                </div>
                <div class="inline-form-foot">
                  <span class="muted">The path must already be a git repository.</span>
                  <button class="btn secondary" type="button" onClick=${reset}>Cancel</button>
                  <button class="btn primary" type="submit" disabled=${saving}>${saving ? 'Adding…' : 'Add project'}</button>
                </div>
              </form>
            `
          : null
      }

      ${
        mode === MODES.idea
          ? html`
              <form class="card inline-form project-form" onSubmit=${submit}>
                <div class="inline-form-head"><h3>Start from an idea</h3>${close}</div>
                <${TextArea}
                  label="The idea, in your own words"
                  value=${idea}
                  onInput=${setIdea}
                  rows=${6}
                  placeholder="A small CLI that renames files in bulk: a dry run, then a confirmation, then the moves."
                  loading=${saving}
                />
                <${TextInput} label="Project name (optional)" value=${name} onInput=${setName} placeholder="bulk-renamer" loading=${saving} />
                <div class="inline-form-foot">
                  <span class="muted">Nothing is created until you approve the drafted spec.</span>
                  <button class="btn secondary" type="button" onClick=${reset}>Cancel</button>
                  <button class="btn primary" type="submit" disabled=${saving}>${saving ? 'Drafting…' : 'Draft the project'}</button>
                </div>
              </form>
            `
          : null
      }

      ${
        projects.length
          ? html`
              <div class="project-grid">
                ${projects.map((p) => {
                  const mine = (tasks || []).filter((t) => t.project_id === p.id);
                  const count = (pred) => mine.filter(pred).length;
                  const active = count((t) => !IDLE.has(t.state) && !WAITING.has(t.state));
                  const waiting = count((t) => WAITING.has(t.state));
                  const done = count((t) => t.state === 'COMPLETE');
                  const last = mine.reduce((m, t) => (t.updated_at > m ? t.updated_at : m), '');
                  const facts = [p.language, p.framework].filter((x) => x && x !== 'unknown');
                  return html`
                    <a class="card project-card" key=${p.id} href=${`#/project/${p.id}`}>
                      <div class="project-card-head">
                        <b class="project-card-name">${p.name}</b>
                        ${p.spec
                          ? html`<span class="badge badge-good">Spec</span>`
                          : p.idea
                            ? html`<span class="badge badge-info">Idea only</span>`
                            : html`<span class="badge badge-neutral">No spec</span>`}
                      </div>
                      <span class="project-card-path" title=${p.path}>${shortDir(p.path)}</span>
                      <div class="project-card-stats">
                        <span><b>${active}</b> active</span>
                        <span class=${waiting ? 'warn' : ''}><b>${waiting}</b> waiting on you</span>
                        <span><b>${done}</b> done</span>
                      </div>
                      <div class="project-card-foot muted">
                        <span>${facts.join(' · ') || 'Language not detected'}${(() => {
                          const n = Object.keys(p.commands || {}).length;
                          return ` · ${n} command${n === 1 ? '' : 's'}`;
                        })()}</span>
                        ${p.drafts?.length ? html`<span class="badge badge-info">${p.drafts.length} drafted</span>` : null}
                        ${last ? html`<span>Active <${Time} at=${last} /></span>` : html`<span>No tasks yet</span>`}
                      </div>
                    </a>
                  `;
                })}
              </div>
            `
          : html`<${EmptyState}
              title="No projects yet"
              message="A project is a repository the pipeline may work in."
              hint="Add one by path, or describe an idea and let the draft pass propose a spec."
              actionLabel="New project"
              onAction=${() => setMode(MODES.add)}
            />`
      }
    </div>
  `;
}
