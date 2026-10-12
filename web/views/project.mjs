// A project: its checkout's git state and controls, new tasks, and the work in flight.
import { html, useEffect, useState, recall, remember, shortDir, fuzzy } from '../lib.mjs';
import { api, useStore } from '../api.mjs';
import { showToast } from '../components/toast.mjs';
import { confirmAction } from '../components/confirm.mjs';
import { DiffViewer } from '../components/diff-viewer.mjs';
import { MoreMenu } from '../components/menu.mjs';
import { Time } from '../components/time.mjs';
import { Dialog, Dot, ModelPicker, ModePicker, BranchPicker, sessionsStatus, TaskBadge, StatusBadge, Icon } from '../components/ui.mjs';
import { TerminalPane } from '../components/terminal.mjs';

const toast = (e) => showToast(e.message || String(e), 'error');
export const go = (hash) => (location.hash = hash);

/** The checkout's git state, reloaded whenever the server says the repository moved. */
export function useGit(projectId) {
  const tick = useStore((s) => s.gitTick[projectId] || 0);
  const [git, setGit] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let live = true;
    api
      .git(projectId)
      .then((g) => live && (setGit(g), setError(null)))
      .catch((e) => live && setError(e.message));
    return () => (live = false);
  }, [projectId, tick]);
  return { git, error, reload: () => api.git(projectId).then(setGit).catch(toast) };
}

export function ProjectView({ projectId }) {
  const project = useStore((s) => s.projects.find((p) => p.id === projectId));
  const tasks = useStore((s) => s.tasks);
  const sessions = useStore((s) => s.sessions);
  const { git, error, reload } = useGit(projectId);
  const [showDone, setShowDone] = useState(false);
  const [terminal, setTerminal] = useState(false);

  if (!project) return html`<div class="page muted">No such project.</div>`;
  const mine = tasks.filter((t) => t.project_id === projectId);
  const active = mine.filter((t) => t.state === 'active');
  const done = mine.filter((t) => t.state !== 'active');
  const checkout = sessions.filter((s) => s.project_id === projectId && !s.task_id);

  const newSession = async () => {
    try {
      const s = await api.createSession({ projectId });
      go(`#/p/${projectId}/s/${s.id}`);
    } catch (e) {
      toast(e);
    }
  };

  return html`
    <div class="page">
      <header class="page-header">
        <div>
          <h1>${project.name}</h1>
          <div class="muted mono-sm" title=${project.path}>${shortDir(project.path)}</div>
        </div>
        <${MoreMenu}
          items=${[
            { label: 'Terminal in checkout', onSelect: () => setTerminal(true) },
            {
              label: 'Rename project',
              onSelect: () => {
                const name = prompt('Project name', project.name);
                if (name?.trim()) api.renameProject(projectId, name.trim()).then(() => import('../api.mjs').then((m) => m.refresh())).catch(toast);
              },
            },
            {
              label: 'Remove project',
              danger: true,
              onSelect: async () => {
                if (await confirmAction({ title: `Remove ${project.name}?`, body: 'It is unregistered here. The directory, its branches and worktrees are left as they are.', confirmLabel: 'Remove', tone: 'danger' })) {
                  await api.removeProject(projectId).catch(toast);
                  (await import('../api.mjs')).refresh();
                  go('#/');
                }
              },
            },
          ]}
        />
      </header>

      ${error ? html`<div class="notice notice-bad">${error}</div>` : html`<${GitBar} projectId=${projectId} git=${git} reload=${reload} />`}

      <${NewTask} projectId=${projectId} git=${git} />

      <section class="section">
        <div class="section-head"><h2>Tasks</h2><span class="badge badge-neutral">${active.length}</span></div>
        ${active.length
          ? html`<div class="list">${active.map((t) => html`<${TaskRow} key=${t.id} task=${t} sessions=${sessions.filter((s) => s.task_id === t.id)} />`)}</div>`
          : html`<div class="muted empty-line">No active tasks. Start one above; each gets its own branch and worktree.</div>`}
      </section>

      <section class="section">
        <div class="section-head">
          <h2>Sessions in the checkout</h2>
          <button class="btn sm secondary" type="button" onClick=${newSession}><${Icon} name="plus" /> New session</button>
        </div>
        <p class="muted section-hint">These work directly in ${git?.branch ? html`<code>${git.branch}</code>` : 'the checkout'}, with no worktree and no merge step.</p>
        ${checkout.length
          ? html`<div class="list">
              ${checkout.map(
                (s) => html`<a class="list-row" href=${`#/p/${projectId}/s/${s.id}`} key=${s.id}>
                  <div class="list-row-main"><${Dot} status=${s.status} /> <span class="row-title">${s.title}</span></div>
                  <div class="list-row-side"><${StatusBadge} status=${s.status} /><${Time} at=${s.updated_at} /></div>
                </a>`
              )}
            </div>`
          : null}
      </section>

      ${done.length
        ? html`<section class="section">
            <button class="section-toggle" type="button" onClick=${() => setShowDone((v) => !v)}>${showDone ? '▾' : '▸'} Merged and closed (${done.length})</button>
            ${showDone ? html`<div class="list">${done.map((t) => html`<${TaskRow} key=${t.id} task=${t} sessions=${[]} />`)}</div>` : null}
          </section>`
        : null}

      ${terminal
        ? html`<${Dialog} wide title=${`Terminal · ${project.name}`} onClose=${() => setTerminal(false)}>
            <div class="terminal-dialog"><${TerminalPane} query=${{ project: projectId }} /></div>
          <//>`
        : null}
    </div>
  `;
}

function TaskRow({ task: t, sessions }) {
  const status = sessionsStatus(sessions);
  return html`
    <a class="list-row" href=${`#/p/${t.project_id}/t/${t.id}`}>
      <div class="list-row-main">
        ${t.state === 'active' ? html`<${Dot} status=${status} />` : null}
        <span class="row-title">${t.title}</span>
        <span class="muted mono-sm hide-narrow">from ${t.base_branch}</span>
      </div>
      <div class="list-row-side">
        ${t.state === 'active' ? (status !== 'idle' ? html`<${StatusBadge} status=${status} />` : null) : html`<${TaskBadge} state=${t.state} />`}
        <${Time} at=${t.updated_at} />
      </div>
    </a>
  `;
}

// -- git ----------------------------------------------------------------------------------

function GitBar({ projectId, git, reload }) {
  const [busy, setBusy] = useState(null);
  const [dialog, setDialog] = useState(null);
  if (!git) return html`<div class="gitbar muted">Reading the repository…</div>`;

  const run = async (label, fn) => {
    setBusy(label);
    try {
      await fn();
      await reload();
    } catch (e) {
      toast(e);
    } finally {
      setBusy(null);
    }
  };

  return html`
    <div class="gitbar card">
      <button class="branch-btn" type="button" onClick=${() => setDialog('branch')} title="Switch branch">
        <${Icon} name="branch" /> <span>${git.branch || 'detached HEAD'}</span> <span class="muted">▾</span>
      </button>
      <div class="git-status">
        ${git.dirty.length ? html`<button class="link-btn" type="button" onClick=${() => setDialog('diff')}>${git.dirty.length} changed</button>` : html`<span class="muted">clean</span>`}
        ${git.upstream ? html`<span class="muted" title=${`against ${git.upstream}`}>↑${git.ahead} ↓${git.behind}</span>` : git.hasRemote ? html`<span class="muted">no upstream</span>` : null}
        ${git.conflicted.length ? html`<span class="badge badge-bad">${git.conflicted.length} conflicted</span>` : null}
      </div>
      <div class="git-actions">
        ${git.hasRemote ? html`<button class="btn sm secondary" disabled=${!!busy} type="button" onClick=${() => run('fetch', () => api.fetch(projectId))}>${busy === 'fetch' ? 'Fetching…' : 'Fetch'}</button>` : null}
        ${git.upstream && git.behind ? html`<button class="btn sm secondary" disabled=${!!busy} type="button" onClick=${() => run('pull', () => api.pull(projectId))}>${busy === 'pull' ? 'Pulling…' : `Pull ${git.behind}`}</button>` : null}
        ${git.hasRemote && git.branch && (git.ahead || !git.upstream) ? html`<button class="btn sm secondary" disabled=${!!busy} type="button" onClick=${() => run('push', () => api.push(projectId))}>${busy === 'push' ? 'Pushing…' : 'Push'}</button>` : null}
        ${git.dirty.length ? html`<button class="btn sm" disabled=${!!busy} type="button" onClick=${() => setDialog('commit')}>Commit</button>` : null}
      </div>
      ${dialog === 'branch' ? html`<${SwitchBranch} projectId=${projectId} git=${git} onClose=${() => setDialog(null)} onDone=${reload} />` : null}
      ${dialog === 'commit' ? html`<${CommitDialog} title="Commit in the checkout" files=${git.dirty} onClose=${() => setDialog(null)} onCommit=${(m) => api.commit(projectId, m).then(reload)} onDiff=${() => setDialog('diff')} />` : null}
      ${dialog === 'diff' ? html`<${CheckoutDiff} projectId=${projectId} onClose=${() => setDialog(null)} />` : null}
    </div>
  `;
}

function SwitchBranch({ projectId, git, onClose, onDone }) {
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const branches = git.branches
    .map((b) => ({ b, score: q ? fuzzy(b.name, q) : 0 }))
    .filter((x) => x.score !== null)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.b);

  const sw = async (body) => {
    try {
      await api.checkout(projectId, body);
      onDone();
      onClose();
    } catch (e) {
      if (e.data?.code === 'DIRTY') {
        const ok = await confirmAction({ title: 'Stash your changes?', body: `${e.data.dirty.length} uncommitted change${e.data.dirty.length === 1 ? '' : 's'} on ${git.branch}. They will be kept in a stash entry you can pop later.`, confirmLabel: 'Stash and switch' });
        if (ok) return sw({ ...body, stash: true });
        return;
      }
      toast(e);
    }
  };

  return html`
    <${Dialog} title="Switch branch" onClose=${onClose}>
      <input class="input" placeholder=${creating ? 'New branch name' : 'Find a branch'} value=${q} onInput=${(e) => setQ(e.target.value)}
        onKeyDown=${(e) => e.key === 'Enter' && (creating ? q.trim() && sw({ branch: q.trim(), create: true }) : branches[0] && sw({ branch: branches[0].name }))} />
      ${creating
        ? html`<div class="row"><button class="btn" type="button" disabled=${!q.trim()} onClick=${() => sw({ branch: q.trim(), create: true })}>Create from ${git.branch || 'HEAD'}</button><button class="btn ghost" type="button" onClick=${() => setCreating(false)}>Back</button></div>`
        : html`
            <div class="branch-list">
              ${branches.map(
                (b) => html`<button type="button" class="branch-item ${b.current ? 'current' : ''}" disabled=${b.current} onClick=${() => sw({ branch: b.name })}>
                  <span>${b.name}</span>${b.current ? html`<span class="muted">checked out</span>` : b.remoteOnly ? html`<span class="muted">remote</span>` : null}
                </button>`
              )}
            </div>
            <button class="btn secondary" type="button" onClick=${() => setCreating(true)}><${Icon} name="plus" /> New branch</button>
          `}
    <//>
  `;
}

export function CommitDialog({ title, files, onClose, onCommit, onDiff, initial = '' }) {
  const [message, setMessage] = useState(initial);
  const [busy, setBusy] = useState(false);
  const commit = async () => {
    setBusy(true);
    try {
      await onCommit(message);
      showToast('Committed', 'success');
      onClose();
    } catch (e) {
      toast(e);
      setBusy(false);
    }
  };
  return html`
    <${Dialog}
      title=${title}
      onClose=${onClose}
      actions=${html`<button class="btn ghost" type="button" onClick=${onClose}>Cancel</button><button class="btn primary" type="button" disabled=${busy || !message.trim()} onClick=${commit}>Commit ${files.length} file${files.length === 1 ? '' : 's'}</button>`}
    >
      <textarea class="input" rows="3" placeholder="Commit message" value=${message} onInput=${(e) => setMessage(e.target.value)} />
      <div class="file-list mono-sm">${files.slice(0, 30).map((f) => html`<div>${f}</div>`)}${files.length > 30 ? html`<div class="muted">and ${files.length - 30} more</div>` : null}</div>
      ${onDiff ? html`<button class="link-btn" type="button" onClick=${onDiff}>View the changes</button>` : null}
    <//>
  `;
}

function CheckoutDiff({ projectId, onClose }) {
  const [diff, setDiff] = useState(null);
  useEffect(() => {
    api.checkoutDiff(projectId).then((r) => setDiff(r.diff)).catch(toast);
  }, [projectId]);
  return html`<${Dialog} wide title="Uncommitted changes" onClose=${onClose}>${diff === null ? html`<span class="muted">Loading…</span>` : diff ? html`<${DiffViewer} diff=${diff} />` : html`<span class="muted">No changes.</span>`}<//>`;
}

// -- new task -----------------------------------------------------------------------------

function NewTask({ projectId, git }) {
  const providers = useStore((s) => s.providers);
  const defaults = useStore((s) => s.defaults);
  const key = `ai-code:new-task:${projectId}`;
  const [prompt, setPrompt] = useState(() => recall(key, ''));
  const [title, setTitle] = useState('');
  const [base, setBase] = useState(null);
  const [model, setModel] = useState(null);
  const [mode, setMode] = useState(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => remember(key, prompt || null), [prompt]);

  const baseBranch = base || git?.branch || git?.branches?.[0]?.name || '';
  const chosen = model || { providerId: defaults.providerId, modelId: defaults.modelId };

  const start = async () => {
    setBusy(true);
    try {
      const r = await api.createTask({ projectId, prompt, title, baseBranch, providerId: chosen.providerId, modelId: chosen.modelId, mode: mode || defaults.mode });
      setPrompt('');
      setTitle('');
      go(`#/p/${projectId}/t/${r.task.id}/s/${r.session.id}`);
    } catch (e) {
      toast(e);
    } finally {
      setBusy(false);
    }
  };

  return html`
    <section class="card new-task">
      <textarea
        class="input"
        rows=${open || prompt ? 4 : 2}
        placeholder="New task: describe what you want done. It runs in its own branch and worktree."
        value=${prompt}
        onFocus=${() => setOpen(true)}
        onInput=${(e) => setPrompt(e.target.value)}
        onKeyDown=${(e) => (e.metaKey || e.ctrlKey) && e.key === 'Enter' && prompt.trim() && start()}
      />
      ${open || prompt
        ? html`
            <div class="new-task-opts">
              <label class="field"><span class="field-label">Title (optional)</span><input class="input" placeholder="From the first line" value=${title} onInput=${(e) => setTitle(e.target.value)} /></label>
              ${git?.branches?.length ? html`<div class="field"><span class="field-label">Branch from</span><${BranchPicker} branches=${git.branches} value=${baseBranch} onChange=${setBase} /></div>` : null}
              <div class="field"><span class="field-label">Model</span><${ModelPicker} providers=${providers} value=${chosen} onChange=${setModel} /></div>
              <div class="field"><span class="field-label">Permissions</span><${ModePicker} value=${mode || defaults.mode} onChange=${setMode} /></div>
            </div>
            <div class="row new-task-foot">
              <button class="btn" type="button" disabled=${busy || (!prompt.trim() && !title.trim()) || !baseBranch} onClick=${start}>${busy ? 'Starting…' : 'Start task'}</button>
              <span class="muted hide-touch">⌘↵</span>
            </div>
          `
        : null}
    </section>
  `;
}
