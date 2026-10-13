// The inbox: everything waiting on a person, answerable where it is listed rather than
// one tap away inside its conversation, with what finished recently below it.
//
// On a phone this is the home screen. A push arrives, the app opens here, and the
// question that woke it can be answered without navigating: the approval card above is
// the same one the transcript draws, so Allow and Deny are the same buttons in the same
// place, not a second implementation that can drift from the first.
import { html, formatWhen } from '../lib.mjs';
import { useStore } from '../api.mjs';
import { ApprovalCard } from './session.mjs';
import { Dot } from '../components/ui.mjs';

export function Inbox() {
  const approvals = useStore((s) => s.approvals);
  const sessions = useStore((s) => s.sessions);
  const tasks = useStore((s) => s.tasks);
  const projects = useStore((s) => s.projects);

  const where = (s) => [projects.find((p) => p.id === s.project_id)?.name, tasks.find((t) => t.id === s.task_id)?.title].filter(Boolean).join(' · ');
  const href = (s) => (s.task_id ? `#/p/${s.project_id}/t/${s.task_id}/s/${s.id}` : `#/p/${s.project_id}/s/${s.id}`);
  // What settled since: a session that is no longer working. Newest first, and capped -
  // this is a glance at what just finished, not a second copy of the sessions list.
  const recent = sessions
    .filter((s) => s.status === 'idle' || s.status === 'error')
    .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
    .slice(0, 8);

  return html`
    <div class="page">
      <header class="page-header">
        <h1>Inbox</h1>
        ${approvals.length ? html`<span class="badge badge-warn">${approvals.length} waiting</span>` : null}
      </header>

      ${approvals.length
        ? html`<div class="inbox-list">
            ${approvals.map((a) => {
              const s = sessions.find((x) => x.id === a.session_id);
              if (!s) return null;
              return html`<div class="inbox-item" key=${a.id}>
                <a class="inbox-where" href=${href(s)}>
                  <${Dot} status="waiting" />
                  <span class="row-title">${s.title}</span>
                  <span class="muted inbox-where-tag">${where(s)}</span>
                </a>
                <${ApprovalCard} approval=${a} />
              </div>`;
            })}
          </div>`
        : html`<div class="card empty-card">
            <h2>Nothing waiting</h2>
            <p class="muted">When Claude needs a decision, or finishes a turn, it lands here.</p>
          </div>`}

      ${recent.length
        ? html`<section class="section">
            <div class="section-head"><h2>Recently finished</h2></div>
            <div class="list">
              ${recent.map(
                (s) => html`<a class="list-row ${s.status === 'error' ? 'attention-bad' : ''}" href=${href(s)} key=${s.id}>
                  <div class="list-row-main"><${Dot} status=${s.status} /><span class="row-title">${s.title}</span></div>
                  <div class="list-row-side muted">${[where(s), formatWhen(s.updated_at)].filter(Boolean).join(' · ')}</div>
                </a>`
              )}
            </div>
          </section>`
        : null}
    </div>
  `;
}
