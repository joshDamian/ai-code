// A task: its sessions, what it changed against its base, a shell in its worktree, and
// the way back into the base branch.
import { html, useEffect, useState } from '../lib.mjs';
import { api, useStore } from '../api.mjs';
import { showToast } from '../components/toast.mjs';
import { DiffViewer } from '../components/diff-viewer.mjs';
import { MoreMenu } from '../components/menu.mjs';
import { TerminalPane } from '../components/terminal.mjs';
import { Dialog, Dot, TaskBadge, Icon } from '../components/ui.mjs';
import { SessionPane } from './session.mjs';
import { CommitDialog, go } from './project.mjs';

const toast = (e) => showToast(e.message || String(e), 'error');

function useTaskGit(task) {
  const tick = useStore((s) => s.gitTick[task?.project_id] || 0);
  const sessionsBusy = useStore((s) => s.sessions.filter((x) => x.task_id === task?.id && x.status === 'running').length);
  const [git, setGit] = useState(null);
  const load = () => task && api.taskGit(task.id).then(setGit).catch(() => {});
  useEffect(() => {
    load();
  }, [task?.id, task?.state, task?.updated_at, tick, sessionsBusy]);
  return { git, reload: load };
}

export function TaskView({ projectId, taskId, sessionId, tab }) {
  const task = useStore((s) => s.tasks.find((t) => t.id === taskId));
  const all = useStore((s) => s.sessions);
  const [archived, setArchived] = useState([]);
  const { git, reload } = useTaskGit(task);
  const [dialog, setDialog] = useState(null);

  // Archived sessions are not in the live list; a merged task's are all archived.
  useEffect(() => {
    api.task(taskId).then((r) => setArchived(r.sessions.filter((s) => s.archived_at))).catch(() => {});
  }, [taskId, task?.state]);

  if (!task) return html`<div class="page muted">No such task.</div>`;
  const sessions = [...all.filter((s) => s.task_id === taskId), ...archived.filter((a) => !all.some((s) => s.id === a.id))];
  const current = tab ? null : sessions.find((s) => s.id === sessionId) || sessions[0];
  const base = `#/p/${projectId}/t/${taskId}`;
  const active = task.state === 'active';

  const newSession = async () => {
    try {
      const s = await api.createSession({ projectId, taskId });
      go(`${base}/s/${s.id}`);
    } catch (e) {
      toast(e);
    }
  };

  const act = async (fn, done) => {
    try {
      const r = await fn();
      if (done) showToast(done, 'success');
      reload();
      return r;
    } catch (e) {
      toast(e);
    }
  };

  const rename = () => {
    const title = prompt('Rename task', task.title);
    if (title?.trim() && title !== task.title) api.renameTask(taskId, title).catch(toast);
  };

  return html`
    <div class="task-view">
      <header class="task-head">
        <div class="task-title-row">
          <button class="title-btn h1" type="button" onClick=${rename} title="Rename">${task.title}</button>
          <${TaskBadge} state=${task.state} />
        </div>
        <div class="task-meta">
          <code class="mono-sm">${task.branch}</code><span class="muted"> → </span><code class="mono-sm">${task.base_branch}</code>
          ${git
            ? html`<span class="muted git-counts">
                ${git.ahead ? html` · ${git.ahead} commit${git.ahead === 1 ? '' : 's'}` : ''}${git.dirty.length ? html` · ${git.dirty.length} uncommitted` : ''}${git.files ? html` · <span class="good">+${git.added}</span> <span class="bad">−${git.removed}</span>` : ''}${git.behind ? html` · ${git.behind} behind ${task.base_branch}` : ''}
              </span>`
            : null}
        </div>
        <div class="task-actions">
          ${active
            ? html`
                ${git?.behind ? html`<button class="btn sm secondary" type="button" onClick=${() => act(() => api.updateTask(taskId), null).then((r) => r && (r.conflicts?.length ? (showToast('Conflicts to resolve: see Changes', 'error'), go(`${base}/changes`)) : showToast(`Merged ${task.base_branch} in`, 'success')))}>Update from ${task.base_branch}</button>` : null}
                <button class="btn sm" type="button" disabled=${!git?.canMerge?.ok} title=${git?.canMerge?.reason || ''} onClick=${() => setDialog('merge')}>Merge into ${task.base_branch}</button>
              `
            : task.state === 'closed'
              ? html`<button class="btn sm secondary" type="button" onClick=${() => act(() => api.reopenTask(taskId), 'Reopened')}>Reopen</button>`
              : null}
          <${MoreMenu}
            items=${active
              ? [
                  git?.dirty?.length ? { label: 'Commit…', onSelect: () => setDialog('commit') } : null,
                  { label: 'Push branch', onSelect: () => act(() => api.pushTask(taskId), 'Pushed') },
                  { label: 'Open a pull request…', onSelect: () => setDialog('pr') },
                  { label: 'Close task…', danger: true, onSelect: () => setDialog('close') },
                ]
              : [{ label: 'Back to project', onSelect: () => go(`#/p/${projectId}`) }]}
          />
        </div>
      </header>

      <nav class="task-tabs" role="tablist">
        ${sessions.map(
          (s) => html`<a role="tab" class="task-tab ${current?.id === s.id ? 'active' : ''} ${s.archived_at ? 'archived' : ''}" href=${`${base}/s/${s.id}`} key=${s.id}><${Dot} status=${s.status} /><span>${s.title}</span></a>`
        )}
        ${active ? html`<button class="task-tab add" type="button" onClick=${newSession} aria-label="New session in this task"><${Icon} name="plus" /></button>` : null}
        <span class="tab-gap"></span>
        <a role="tab" class="task-tab ${tab === 'changes' ? 'active' : ''}" href=${`${base}/changes`}>Changes${git?.files ? html` <span class="count">${git.files}</span>` : ''}${git?.conflicted?.length ? html` <span class="badge badge-bad">!</span>` : ''}</a>
        ${active ? html`<a role="tab" class="task-tab ${tab === 'terminal' ? 'active' : ''}" href=${`${base}/terminal`}><${Icon} name="terminal" /> Terminal</a>` : null}
      </nav>

      <div class="task-body">
        ${tab === 'changes'
          ? html`<${Changes} task=${task} git=${git} sessions=${sessions} reload=${reload} />`
          : tab === 'terminal'
            ? html`<div class="terminal-page"><${TerminalPane} query=${{ task: taskId }} /></div>`
            : current
              ? html`<${SessionPane} key=${current.id} sessionId=${current.id} onArchived=${() => go(base)} />`
              : html`<div class="pane-empty"><p class="muted">No sessions in this task.</p>${active ? html`<button class="btn" type="button" onClick=${newSession}>Start a session</button>` : null}</div>`}
      </div>

      ${dialog === 'merge' ? html`<${MergeDialog} task=${task} git=${git} onClose=${() => setDialog(null)} />` : null}
      ${dialog === 'commit' ? html`<${CommitDialog} title="Commit in the task" initial=${task.title} files=${git?.dirty || []} onClose=${() => setDialog(null)} onCommit=${(m) => api.commitTask(taskId, m).then(reload)} />` : null}
      ${dialog === 'pr' ? html`<${PrDialog} task=${task} onClose=${() => setDialog(null)} />` : null}
      ${dialog === 'close' ? html`<${CloseDialog} task=${task} onClose=${() => setDialog(null)} />` : null}
    </div>
  `;
}

function Changes({ task, git, sessions, reload }) {
  const tick = useStore((s) => s.gitTick[task.project_id] || 0);
  const [diff, setDiff] = useState(null);
  useEffect(() => {
    api.taskDiff(task.id).then((r) => setDiff(r.diff)).catch(toast);
  }, [task.id, tick, git?.files, git?.added, git?.removed, git?.dirty?.length]);

  const resolve = async () => {
    const s = sessions.find((x) => !x.archived_at);
    if (!s) return toast(new Error('Start a session first'));
    await api.send(s.id, `Merging ${task.base_branch} into this branch left conflicts in: ${git.conflicted.join(', ')}. Resolve them, keeping both sides' intent, then commit the merge.`).catch(toast);
    go(`#/p/${task.project_id}/t/${task.id}/s/${s.id}`);
  };

  return html`
    <div class="changes">
      ${git?.conflicted?.length
        ? html`<div class="notice notice-warn">
            <div><strong>Merge conflicts</strong> in ${git.conflicted.map((f) => html`<code>${f}</code> `)}</div>
            <div class="row">
              <button class="btn sm" type="button" onClick=${resolve}>Ask Claude to resolve them</button>
              <button class="btn sm secondary" type="button" onClick=${() => api.abortMerge(task.id).then(reload).catch(toast)}>Abort the merge</button>
            </div>
          </div>`
        : null}
      ${git && !git.canMerge.ok && git.canMerge.conflicts.length && !git.conflicted.length
        ? html`<div class="notice notice-warn">
            Merging now would conflict with <code>${task.base_branch}</code> in ${git.canMerge.conflicts.map((f) => html`<code>${f}</code> `)}.
            Update from ${task.base_branch} to resolve them here first.
          </div>`
        : null}
      ${diff === null ? html`<div class="muted">Loading…</div>` : diff ? html`<${DiffViewer} diff=${diff} nav storageKey=${`bench:viewed:${task.id}`} />` : html`<div class="muted pane-empty">No changes against ${task.base_branch} yet.</div>`}
    </div>
  `;
}

function MergeDialog({ task, git, onClose }) {
  const [strategy, setStrategy] = useState('merge');
  const [message, setMessage] = useState('');
  const [cleanup, setCleanup] = useState(true);
  const [busy, setBusy] = useState(false);
  const merge = async () => {
    setBusy(true);
    try {
      const r = await api.mergeTask(task.id, { strategy, message, cleanup });
      showToast(`Merged into ${task.base_branch}${r.fastForward ? ' (fast-forward)' : ''}`, 'success');
      onClose();
    } catch (e) {
      toast(e);
      setBusy(false);
    }
  };
  return html`
    <${Dialog}
      title=${`Merge into ${task.base_branch}`}
      onClose=${onClose}
      actions=${html`<button class="btn ghost" type="button" onClick=${onClose}>Cancel</button><button class="btn primary" type="button" disabled=${busy} onClick=${merge}>${busy ? 'Merging…' : 'Merge'}</button>`}
    >
      ${git?.dirty?.length ? html`<p class="muted">${git.dirty.length} uncommitted file${git.dirty.length === 1 ? ' is' : 's are'} committed first, as "${task.title}".</p>` : null}
      <div class="choices">
        <button type="button" class="choice ${strategy === 'merge' ? 'picked' : ''}" onClick=${() => setStrategy('merge')}><strong>Merge</strong><span class="muted">Keep the task's commits${git?.ahead ? ` (${git.ahead})` : ''}; fast-forward when possible</span></button>
        <button type="button" class="choice ${strategy === 'squash' ? 'picked' : ''}" onClick=${() => setStrategy('squash')}><strong>Squash</strong><span class="muted">One commit on ${task.base_branch}</span></button>
      </div>
      <input class="input" placeholder=${strategy === 'squash' ? task.title : `Merge task: ${task.title}`} value=${message} onInput=${(e) => setMessage(e.target.value)} />
      <label class="check"><input type="checkbox" checked=${cleanup} onChange=${(e) => setCleanup(e.target.checked)} /> Remove the worktree and branch afterwards</label>
      <p class="muted">If ${task.base_branch} is checked out, the merge happens in that checkout, and git refuses if it would overwrite uncommitted changes there.</p>
    <//>
  `;
}

function PrDialog({ task, onClose }) {
  const [title, setTitle] = useState(task.title);
  const [body, setBody] = useState(task.description || '');
  const [busy, setBusy] = useState(false);
  const open = async () => {
    setBusy(true);
    try {
      const r = await api.pullRequest(task.id, { title, body });
      showToast('Pull request opened', 'success');
      window.open(r.url, '_blank', 'noopener');
      onClose();
    } catch (e) {
      toast(e);
      setBusy(false);
    }
  };
  return html`
    <${Dialog}
      title=${`Pull request into ${task.base_branch}`}
      onClose=${onClose}
      actions=${html`<button class="btn ghost" type="button" onClick=${onClose}>Cancel</button><button class="btn primary" type="button" disabled=${busy || !title.trim()} onClick=${open}>${busy ? 'Opening…' : 'Push and open'}</button>`}
    >
      <input class="input" value=${title} onInput=${(e) => setTitle(e.target.value)} />
      <textarea class="input" rows="6" placeholder="Description" value=${body} onInput=${(e) => setBody(e.target.value)} />
      <p class="muted">Uses the GitHub CLI on the server. Uncommitted work is committed first.</p>
    <//>
  `;
}

function CloseDialog({ task, onClose }) {
  const [deleteBranch, setDeleteBranch] = useState(false);
  const close = async () => {
    try {
      await api.closeTask(task.id, { deleteBranch });
      onClose();
      go(`#/p/${task.project_id}`);
    } catch (e) {
      toast(e);
    }
  };
  return html`
    <${Dialog}
      title="Close this task?"
      onClose=${onClose}
      actions=${html`<button class="btn ghost" type="button" onClick=${onClose}>Cancel</button><button class="btn danger" type="button" onClick=${close}>Close task</button>`}
    >
      <p class="muted">The worktree is removed and its sessions archived. Uncommitted work in it is lost.</p>
      <label class="check"><input type="checkbox" checked=${deleteBranch} onChange=${(e) => setDeleteBranch(e.target.checked)} /> Also delete <code>${task.branch}</code> (it cannot be reopened then)</label>
    <//>
  `;
}

