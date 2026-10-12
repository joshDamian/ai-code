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

const TABS = [
  { id: 'clone', label: 'Clone' },
  { id: 'folder', label: 'Open folder' },
  { id: 'new', label: 'New' },
];

/** The folder a repository name would clone into, for showing before it happens. */
const repoName = (spec) => (/([^/:]+?)(?:\.git)?\/?$/.exec(spec.trim())?.[1] || '').replace(/^\.+/, '');
const tidy = (p) => String(p || '').replace(/\/+$/, '');

export function AddProject({ onClose }) {
  const defaults = useStore((s) => s.defaults);
  const [tab, setTab] = useState('clone');
  const [repo, setRepo] = useState('');
  const [name, setName] = useState('');
  const [dest, setDest] = useState(null);
  const [picking, setPicking] = useState(false);
  const [folder, setFolder] = useState('');
  const [busy, setBusy] = useState(false);
  const into = dest || defaults.projectsDir;

  const done = async (p) => {
    await refresh();
    onClose();
    go(`#/p/${p.id}`);
  };
  const run = async (fn) => {
    setBusy(true);
    try {
      await done(await fn());
    } catch (e) {
      setBusy(false);
      if (e.data?.code === 'NOT_A_REPO' && confirm(`${folder} is not a git repository. Initialise one here?`)) return run(() => api.addProject({ path: folder, init: true }));
      toast(e);
    }
  };

  const target = tab === 'clone' ? (name.trim() || repoName(repo)) : name.trim();
  const action =
    tab === 'clone'
      ? html`<button class="btn primary" type="button" disabled=${busy || !repo.trim()} onClick=${() => run(() => api.cloneProject({ repo, dir: into, name: name.trim() || undefined }))}>${busy ? 'Cloning…' : 'Clone'}</button>`
      : tab === 'new'
        ? html`<button class="btn primary" type="button" disabled=${busy || !name.trim()} onClick=${() => run(() => api.createProject({ name, dir: into }))}>${busy ? 'Creating…' : 'Create'}</button>`
        : html`<button class="btn primary" type="button" disabled=${busy || !folder} onClick=${() => run(() => api.addProject({ path: folder }))}>${busy ? 'Adding…' : 'Add'}</button>`;

  return html`
    <${Dialog} wide title="Add a project" onClose=${onClose} actions=${html`<button class="btn ghost" type="button" onClick=${onClose}>Cancel</button>${action}`}>
      <div class="seg" role="tablist">
        ${TABS.map((t) => html`<button type="button" role="tab" aria-selected=${tab === t.id} class=${tab === t.id ? 'on' : ''} onClick=${() => setTab(t.id)}>${t.label}</button>`)}
      </div>

      ${tab === 'clone' ? html`<${RepoPicker} value=${repo} onChange=${setRepo} />` : null}
      ${tab === 'folder' ? html`<${FolderBrowser} start=${defaults.projectsDir} onPick=${setFolder} picked=${folder} hint="Choose a folder that already holds a project." />` : null}
      ${tab === 'new' ? html`<label class="field"><span class="field-label">Name</span><input class="input" placeholder="my-project" value=${name} onInput=${(e) => setName(e.target.value)} /></label>` : null}

      ${tab !== 'folder'
        ? html`
            ${tab === 'clone' ? html`<label class="field"><span class="field-label">Folder name (optional)</span><input class="input" placeholder=${repoName(repo) || 'From the repository'} value=${name} onInput=${(e) => setName(e.target.value)} /></label>` : null}
            <div class="field">
              <span class="field-label">Location</span>
              <div class="dest">
                <code class="dest-path">${tidy(into)}/${target || '…'}</code>
                <button class="btn sm secondary" type="button" onClick=${() => setPicking((v) => !v)}>${picking ? 'Done' : 'Change'}</button>
              </div>
              ${picking ? html`<${FolderBrowser} start=${into} onPick=${setDest} picked=${into} hint="The project is created inside the folder you choose." />` : null}
              ${dest && tidy(dest) !== tidy(defaults.projectsDir) ? html`<button class="link-btn" type="button" onClick=${() => setDest(null)}>Use the default folder (${defaults.projectsDir})</button>` : null}
            </div>
          `
        : null}
      ${busy && tab === 'clone' ? html`<p class="muted">Cloning. A large repository can take a few minutes.</p>` : null}
    <//>
  `;
}

/** Your GitHub repositories, filtered as you type, or any URL or owner/name typed in. */
function RepoPicker({ value, onChange }) {
  const [gh, setGh] = useState(null);
  useEffect(() => {
    api.githubRepos().then(setGh).catch(() => setGh({ ready: false, repos: [] }));
  }, []);
  const q = value.trim().toLowerCase();
  const shown = (gh?.repos || []).filter((r) => !q || r.name.toLowerCase().includes(q) || r.description.toLowerCase().includes(q)).slice(0, 50);
  return html`
    <label class="field">
      <span class="field-label">Repository</span>
      <input class="input mono-sm" placeholder="owner/name, or any git URL" value=${value} onInput=${(e) => onChange(e.target.value)} autofocus />
    </label>
    ${gh === null
      ? html`<div class="muted">Looking for your GitHub repositories…</div>`
      : gh.ready
        ? html`<div class="browser repo-list">
            ${shown.length
              ? shown.map(
                  (r) => html`<button type="button" class="browser-item ${value === r.name ? 'picked' : ''}" onClick=${() => onChange(r.name)}>
                    <${Icon} name="branch" />
                    <span class="repo-row"><span class="mono-sm">${r.name}</span>${r.description ? html`<span class="muted">${r.description}</span>` : null}</span>
                    ${r.private ? html`<span class="badge badge-neutral">private</span>` : null}
                  </button>`
                )
              : html`<div class="browser-item muted">No repository of yours matches. Clone it by URL or owner/name.</div>`}
          </div>`
        : html`<div class="muted">To list your repositories here, run <code>gh auth login</code> on the server. You can still paste a URL or owner/name.</div>`}
  `;
}

/** A folder browser that can make new folders. `onPick` gets the folder being viewed. */
function FolderBrowser({ start, onPick, picked, hint }) {
  const [listing, setListing] = useState(null);
  const [newName, setNewName] = useState(null);
  // Opening shows `start`, or its nearest existing parent, without choosing it; only
  // moving through the folders chooses one.
  const browse = (p, opening = false) =>
    api
      .browse(p)
      .then((r) => {
        setListing(r);
        if (!opening) onPick(r.path);
      })
      .catch(toast);
  useEffect(() => {
    browse(start || undefined, true);
  }, []);
  const make = async () => {
    try {
      const r = await api.mkdir(listing.path, newName);
      setNewName(null);
      browse(r.path);
    } catch (e) {
      toast(e);
    }
  };
  if (!listing) return html`<div class="muted">Loading…</div>`;
  return html`
    <div class="picker-box">
      <div class="dest">
        <code class="dest-path" title=${listing.path}>${listing.path}</code>
        ${newName === null ? html`<button class="btn sm ghost" type="button" onClick=${() => setNewName('')}><${Icon} name="plus" /> New folder</button>` : null}
      </div>
      ${newName !== null
        ? html`<div class="row"><input class="input" placeholder="Folder name" value=${newName} onInput=${(e) => setNewName(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && newName.trim() && make()} autofocus /><button class="btn sm" type="button" disabled=${!newName.trim()} onClick=${make}>Create</button><button class="btn sm ghost" type="button" onClick=${() => setNewName(null)}>Cancel</button></div>`
        : null}
      <div class="browser">
        ${listing.parent ? html`<button type="button" class="browser-item" onClick=${() => browse(listing.parent)}><${Icon} name="back" /> ..</button>` : null}
        ${listing.entries.map(
          (e) => html`<button type="button" class="browser-item" onClick=${() => browse(`${listing.path}/${e.name}`)}>
            <${Icon} name=${e.repo ? 'branch' : 'folder'} /> <span>${e.name}</span>${e.repo ? html`<span class="badge badge-good">git</span>` : null}
          </button>`
        )}
        ${!listing.entries.length ? html`<div class="browser-item muted">No folders here.</div>` : null}
      </div>
      ${hint ? html`<div class="muted field-hint">${hint}</div>` : null}
    </div>
  `;
}
