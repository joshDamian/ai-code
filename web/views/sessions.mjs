// Every session on this machine, flat and newest-activity-first, so a phone can reach
// one without opening its project first. The projects are one tab over; this is the
// list a person actually drives from, filtered to what needs them.
import { html, useState, useEffect, formatWhen } from '../lib.mjs';
import { useStore } from '../api.mjs';
import { Dot, StatusBadge } from '../components/ui.mjs';

const FILTERS = [
  { id: 'open', label: 'Open' },
  { id: 'waiting', label: 'Needs you' },
  { id: 'all', label: 'All' },
];

export function SessionsList() {
  const sessions = useStore((s) => s.sessions);
  const tasks = useStore((s) => s.tasks);
  const projects = useStore((s) => s.projects);
  const [filter, setFilter] = useState('open');

  const where = (s) => [projects.find((p) => p.id === s.project_id)?.name, tasks.find((t) => t.id === s.task_id)?.title].filter(Boolean).join(' · ');
  const href = (s) => (s.task_id ? `#/p/${s.project_id}/t/${s.task_id}/s/${s.id}` : `#/p/${s.project_id}/s/${s.id}`);

  const counts = {
    open: sessions.filter((s) => s.status === 'running' || s.status === 'waiting').length,
    waiting: sessions.filter((s) => s.status === 'waiting').length,
    all: sessions.length,
  };
  const shown = sessions
    .filter((s) => (filter === 'waiting' ? s.status === 'waiting' : filter === 'open' ? s.status === 'running' || s.status === 'waiting' : true))
    .sort((a, b) => {
      // Whatever is waiting on a person comes first, then what is working, then the rest,
      // each newest first - the order a phone should be read in.
      const rank = (s) => (s.status === 'waiting' ? 0 : s.status === 'running' ? 1 : s.status === 'error' ? 2 : 3);
      return rank(a) - rank(b) || Date.parse(b.updated_at) - Date.parse(a.updated_at);
    });

  return html`
    <div class="page">
      <header class="page-header"><h1>Sessions</h1></header>
      <div class="seg" role="tablist">
        ${FILTERS.map(
          (f) => html`<button type="button" role="tab" aria-selected=${filter === f.id} class=${filter === f.id ? 'on' : ''} onClick=${() => setFilter(f.id)}>
            ${f.label}${counts[f.id] ? html` <span class="count">${counts[f.id]}</span>` : null}
          </button>`
        )}
      </div>
      ${shown.length
        ? html`<div class="list">
            ${shown.map(
              (s) => html`<a class="list-row" href=${href(s)} key=${s.id}>
                <div class="list-row-main">
                  <${Dot} status=${s.status} />
                  <span class="row-title">${s.title}</span>
                  ${s.error ? html`<span class="muted session-error">${s.error}</span>` : null}
                </div>
                <div class="list-row-side"><${StatusBadge} status=${s.status} /><span class="muted time">${formatWhen(s.updated_at)}</span></div>
              </a>`
            )}
          </div>`
        : html`<div class="card empty-card"><h2>No sessions here</h2><p class="muted">Start one from a project, or from one of a task's tabs.</p></div>`}
    </div>
  `;
}
