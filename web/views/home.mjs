// The projects, and adding one by browsing to it.
import { html, useEffect, useState, shortDir } from '../lib.mjs';
import { api, useStore, refresh } from '../api.mjs';
import { showToast } from '../components/toast.mjs';
import { Dialog, Dot, sessionsStatus, Icon } from '../components/ui.mjs';
import { go } from './project.mjs';

const toast = (e) => showToast(e.message || String(e), 'error');

export function Home() {
  const projects = useStore((s) => s.projects);
  const tasks = useStore((s) => s.tasks);
  const sessions = useStore((s) => s.sessions);
  const approvals = useStore((s) => s.approvals);
  const [adding, setAdding] = useState(false);

  return html`
    <div class="page">
      <header class="page-header">
        <h1>Projects</h1>
        <button class="btn" type="button" onClick=${() => setAdding(true)}><${Icon} name="plus" /> Add project</button>
      </header>
      ${approvals.length ? html`<${Waiting} />` : null}
      ${projects.length
        ? html`<div class="project-grid">
            ${projects.map((p) => {
              const mine = sessions.filter((s) => s.project_id === p.id);
              const active = tasks.filter((t) => t.project_id === p.id && t.state === 'active');
              return html`
                <a class="card project-card" href=${`#/p/${p.id}`} key=${p.id}>
                  <div class="project-card-head"><${Dot} status=${sessionsStatus(mine)} /><strong>${p.name}</strong></div>
                  <div class="muted mono-sm" title=${p.path}>${shortDir(p.path)}</div>
                  <div class="muted">${active.length} active task${active.length === 1 ? '' : 's'} · ${mine.length} session${mine.length === 1 ? '' : 's'}</div>
                </a>
              `;
            })}
          </div>`
        : html`<div class="card empty-card">
            <h2>No projects yet</h2>
            <p class="muted">Add a git repository on this machine. Tasks you start in it each get their own branch and worktree.</p>
            <button class="btn" type="button" onClick=${() => setAdding(true)}>Add project</button>
          </div>`}
      ${adding ? html`<${AddProject} onClose=${() => setAdding(false)} />` : null}
    </div>
  `;
}

/** Every approval waiting anywhere, so a phone opened to the home page sees them first. */
function Waiting() {
  const approvals = useStore((s) => s.approvals);
  const sessions = useStore((s) => s.sessions);
  return html`
    <section class="section">
      <div class="section-head"><h2>Waiting on you</h2><span class="badge badge-warn">${approvals.length}</span></div>
      <div class="list">
        ${approvals.map((a) => {
          const s = sessions.find((x) => x.id === a.session_id);
          if (!s) return null;
          const href = s.task_id ? `#/p/${s.project_id}/t/${s.task_id}/s/${s.id}` : `#/p/${s.project_id}/s/${s.id}`;
          return html`<a class="list-row attention" href=${href} key=${a.id}>
            <div class="list-row-main"><${Dot} status="waiting" /><span class="row-title">${a.title || a.tool}</span></div>
            <div class="list-row-side muted">${s.title}</div>
          </a>`;
        })}
      </div>
    </section>
  `;
}

export function AddProject({ onClose }) {
  const [dir, setDir] = useState(null);
  const [listing, setListing] = useState(null);
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const browse = (p) =>
    api
      .browse(p)
      .then((r) => {
        setListing(r);
        setDir(r.path);
        setPath(r.path);
      })
      .catch(toast);
  useEffect(() => {
    browse();
  }, []);

  const add = async (init = false) => {
    setBusy(true);
    try {
      const p = await api.addProject({ path, name: name || undefined, init });
      await refresh();
      onClose();
      go(`#/p/${p.id}`);
    } catch (e) {
      setBusy(false);
      if (e.data?.code === 'NOT_A_REPO' && confirm(`${path} is not a git repository. Initialise one here?`)) return add(true);
      toast(e);
    }
  };

  return html`
    <${Dialog}
      wide
      title="Add a project"
      onClose=${onClose}
      actions=${html`<button class="btn ghost" type="button" onClick=${onClose}>Cancel</button><button class="btn primary" type="button" disabled=${busy || !path} onClick=${() => add()}>Add</button>`}
    >
      <label class="field"><span class="field-label">Directory</span><input class="input mono-sm" value=${path} onInput=${(e) => setPath(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && browse(path)} /></label>
      ${listing
        ? html`<div class="browser">
            ${listing.parent ? html`<button type="button" class="browser-item" onClick=${() => browse(listing.parent)}><${Icon} name="back" /> ..</button>` : null}
            ${listing.entries.map(
              (e) => html`<button type="button" class="browser-item" onClick=${() => browse(`${dir}/${e.name}`)}>
                <${Icon} name=${e.repo ? 'branch' : 'folder'} /> <span>${e.name}</span>${e.repo ? html`<span class="badge badge-good">git</span>` : null}
              </button>`
            )}
          </div>`
        : null}
      <label class="field"><span class="field-label">Name (optional)</span><input class="input" placeholder="The directory's name" value=${name} onInput=${(e) => setName(e.target.value)} /></label>
    <//>
  `;
}
