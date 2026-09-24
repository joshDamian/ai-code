// One project's memory: the spec, the drafts waiting for approval, and the decision
// log. URL hash: #/project/:id.
//
// This is the surface every "does a person agree to this" question lands on, and it
// is deliberately one page: the spec a task was planned against, the tasks that have
// not been approved yet and the decisions the finished ones left behind are three
// readings of the same record, and a person deciding whether to approve the fourth
// task usually wants the spec in front of them while they do.
//
// The spec and the drafted tasks are exported on their own because the intake
// conversation renders them too - the turn that drafts a project is a chat turn, and
// having to leave the transcript to approve what it just wrote would be a page load
// between a draft and the button that accepts it. Both surfaces read the same
// component, so there is one place where "approve" means anything.
import { html, useState, useEffect } from '../lib.mjs';
import { api } from '../api.mjs';
import { showToast } from '../components/toast.mjs';
import { Spinner } from '../components/spinner.mjs';
import { TextInput, TextArea } from '../components/form.mjs';
import { Markdown } from '../components/markdown.mjs';
import { DiffViewer } from '../components/diff-viewer.mjs';

// What a decision's state is called on screen. A draft is the one that has not
// landed, which is the only one with buttons on it.
const DECISION_BADGE = { draft: 'badge-warn', approved: 'badge-good', rejected: 'badge-bad' };

export function Project({ id, navigate, onTitle }) {
  const [data, setData] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);

  async function load() {
    try {
      const d = await api.project(id);
      setData(d);
      onTitle?.(d.name);
      setError(null);
      // The task titles the decisions name. A decision records the task it came
      // from by id, and an id is not something a reader can follow.
      setTasks(await api.tasks({ projectId: id }));
    } catch (e) {
      setError(e.message);
    }
  }

  useEffect(() => {
    load();
  }, [id]);

  // Every write answers with the project as it is now, so the page is re-read
  // rather than patched: an approval moves several fields at once - the spec, the
  // draft it consumed, a task that now exists - and one of them left behind would
  // be the page disagreeing with the database.
  async function run(name, fn) {
    setBusy(name);
    try {
      const r = await fn();
      await load();
      return r;
    } catch (e) {
      showToast(e.message, 'error');
      setError(e.message);
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function openProposals() {
    try {
      setBusy('propose-tasks');
      const r = await api.proposeTasks(id);
      // The pass answers in a conversation of its own - a turn like any other - so
      // this opens it: the batch lands on this page, and the transcript that
      // explains it is where a person goes to read why each task was proposed.
      navigate(`#/chat/${r.session.id}`);
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      setBusy(null);
    }
  }

  if (!data) return html`<${Spinner} message="Loading project..." />`;

  const taskTitle = (tid) => tasks.find((t) => t.id === tid)?.title || null;

  return html`
    <div class="stack">
      <div class="card">
        <div class="view-toolbar">
          <div>
            <h1>${data.name}</h1>
            <span class="muted">${data.path} ${data.language ? `· ${data.language}` : ''} ${data.framework ? `· ${data.framework}` : ''}</span>
          </div>
          <div class="list-row-side">
            <button class="btn secondary" onClick=${() => navigate('#/projects')}>Projects</button>
            <button class="btn secondary" disabled=${!!busy} onClick=${openProposals}>What else should I build?</button>
          </div>
        </div>
        ${error ? html`<div class="chat-error">${error}</div>` : null}
        ${
          data.idea && !data.spec
            ? html`<p class="muted">This project came from an idea note. Approving the spec creates the folder, initializes the repository and commits the note.</p>`
            : null
        }
      </div>

      <${MemoryPanel} project=${data} onReload=${load} navigate=${navigate} />

      <div class="card">
        <div class="view-toolbar">
          <h2>Decision log</h2>
          <span class="badge badge-neutral">${data.decisions.filter((d) => d.state === 'approved').length} approved</span>
        </div>
        ${
          data.decisions.length
            ? html`
                <div class="list">
                  ${data.decisions.map(
                    (d) => html`
                      <div class="list-row" key=${d.id}>
                        <div class="list-row-main">
                          <b>${firstLine(d.content)}</b>
                          ${body(d.content) ? html`<span class="muted">${body(d.content)}</span>` : null}
                          <span class="muted">
                            ${taskTitle(d.task_id) ? html`<a href="#/tasks/${d.task_id}">${taskTitle(d.task_id)}</a> · ` : ''}${new Date(d.created_at).toLocaleString()}
                          </span>
                        </div>
                        <div class="list-row-side">
                          <span class="badge ${DECISION_BADGE[d.state] || 'badge-neutral'}">${d.state}</span>
                          ${
                            d.state === 'draft'
                              ? html`
                                  <button class="btn" disabled=${!!busy} onClick=${() => run(`approve-${d.id}`, () => api.approveDecision(d.id))}>Approve</button>
                                  <button class="btn secondary" disabled=${!!busy} onClick=${() => run(`reject-${d.id}`, () => api.rejectDecision(d.id))}>Reject</button>
                                `
                              : null
                          }
                        </div>
                      </div>
                    `
                  )}
                </div>
              `
            : html`<p class="muted">No decisions recorded yet. Completing a task drafts its entries from the change and the review.</p>`
        }
      </div>
    </div>
  `;
}

// The spec and the tasks waiting to become tasks. `project` is the payload
// `GET /api/projects/:id` answers with - the approved text, the draft on the table,
// the revision that diffs them, and the queue of drafted tasks.
export function MemoryPanel({ project, onReload, navigate }) {
  const [busy, setBusy] = useState(null);
  const [editing, setEditing] = useState(false);
  // The two drafts a person writes by hand: the spec they are proposing, and the
  // path the first approval will create. Both are seeded from the project and
  // neither is stored until a button is pressed - which is the same rule the agent's
  // drafts are held to.
  const [specText, setSpecText] = useState(project.spec_draft || project.spec || '');
  const [path, setPath] = useState(project.path);

  useEffect(() => {
    setSpecText(project.spec_draft || project.spec || '');
    setPath(project.path);
  }, [project.id, project.spec, project.spec_draft, project.path]);

  async function run(name, fn) {
    setBusy(name);
    try {
      return await fn();
    } catch (e) {
      showToast(e.message, 'error');
      return null;
    } finally {
      setBusy(null);
    }
  }

  const revision = project.revision || {};
  const waiting = revision.changed;
  // An intake has not been created on disk yet, so approving its spec is also the
  // write that makes the folder and the repository - which is why the path is a
  // field on that approval and only on that one.
  const creating = !!project.idea && !project.spec;

  async function approveSpec() {
    const r = await run('approve-spec', () => api.approveSpec(project.id, path.trim()));
    if (r) {
      showToast(creating ? 'Spec approved, and the project created.' : 'Spec approved.', 'success');
      await onReload?.();
    }
  }

  async function proposeSpec() {
    const r = await run('propose-spec', () => api.proposeSpec(project.id, specText.trim()));
    if (r) {
      setEditing(false);
      await onReload?.();
    }
  }

  async function approveDraft(d) {
    const r = await run(`approve-${d.id}`, () => api.approveDraft(project.id, d.id));
    if (r) {
      showToast('Task created and planned.', 'success');
      await onReload?.();
      if (navigate) navigate(`#/tasks/${r.task.id}`);
    }
  }

  async function dropDraft(d) {
    const r = await run(`drop-${d.id}`, () => api.dropDraft(project.id, d.id));
    if (r) await onReload?.();
  }

  return html`
    <div class="card">
      <div class="view-toolbar">
        <h2>Spec</h2>
        <div class="list-row-side">
          ${
            project.spec
              ? html`<span class="badge badge-neutral">approved ${revision.at ? new Date(revision.at).toLocaleDateString() : ''}</span>`
              : html`<span class="badge badge-neutral">none yet</span>`
          }
          <button class="btn secondary" disabled=${!!busy} onClick=${() => setEditing((v) => !v)}>
            ${editing ? 'Cancel' : waiting ? 'Edit draft' : project.spec ? 'Propose a change' : 'Write it'}
          </button>
        </div>
      </div>

      ${waiting ? html`<p class="muted">A change is waiting for approval.</p>` : null}
      ${waiting ? html`<${DiffViewer} diff=${revision.diff} />` : null}
      ${
        waiting
          ? html`
              <div class="stack">
                ${creating ? html`<${TextInput} label="Folder to create" value=${path} onInput=${setPath} placeholder="/Users/you/code/my-service" loading=${busy === 'approve-spec'} />` : null}
                <div class="list-row-side">
                  <button class="btn" disabled=${!!busy} onClick=${approveSpec}>${busy === 'approve-spec' ? 'Approving…' : 'Approve spec'}</button>
                  <button
                    class="btn danger"
                    disabled=${!!busy}
                    onClick=${async () => {
                      const r = await run('reject-spec', () => api.rejectSpec(project.id));
                      if (r) await onReload?.();
                    }}
                  >
                    Reject
                  </button>
                </div>
              </div>
            `
          : null
      }

      ${
        editing
          ? html`
              <div class="stack">
                <${TextArea}
                  label=${project.spec ? 'Replace the spec with' : 'The spec, in markdown'}
                  value=${specText}
                  onInput=${setSpecText}
                  rows=${12}
                  placeholder="# Goals&#10;&#10;What this is for.&#10;&#10;# Not goals&#10;&#10;What it is deliberately not."
                  loading=${busy === 'propose-spec'}
                />
                <div class="list-row-side">
                  <button class="btn" disabled=${!!busy || !specText.trim()} onClick=${proposeSpec}>
                    ${busy === 'propose-spec' ? 'Proposing…' : 'Propose'}
                  </button>
                </div>
              </div>
            `
          : !waiting && project.spec
            ? html`<div class="md"><${Markdown} text=${project.spec} /></div>`
            : null
      }

      <div class="view-toolbar">
        <h3>Drafted tasks</h3>
        <span class="badge badge-neutral">${project.drafts.length} waiting</span>
      </div>
      ${
        project.drafts.length
          ? html`
              <div class="list">
                ${project.drafts.map(
                  (d) => html`
                    <div class="list-row" key=${d.id}>
                      <div class="list-row-main">
                        <b>${d.title}</b>
                        <span class="muted">${d.description}</span>
                        <span class="muted">from the ${d.source === 'proposal' ? 'proposals pass' : 'idea note'}</span>
                      </div>
                      <div class="list-row-side">
                        <button class="btn" disabled=${!!busy} onClick=${() => approveDraft(d)}>
                          ${busy === `approve-${d.id}` ? 'Creating…' : 'Approve'}
                        </button>
                        <button class="btn secondary" disabled=${!!busy} onClick=${() => dropDraft(d)}>Drop</button>
                      </div>
                    </div>
                  `
                )}
              </div>
            `
          : html`<p class="muted">Nothing is waiting.</p>`
      }
    </div>
  `;
}

// A decision's content is the one line that was decided, then the why. The first
// line is the entry's heading and the rest is its body, which is how the drafting
// pass writes it and how a reader scans a log.
function firstLine(content) {
  return String(content || '').split('\n')[0];
}

function body(content) {
  return String(content || '')
    .split('\n')
    .slice(1)
    .join(' ')
    .trim();
}
