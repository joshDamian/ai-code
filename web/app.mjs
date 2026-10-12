// The shell: routing, the sidebar of projects and their work, and the gates for a
// device that is not paired.
import { html, render, useEffect, useState, recall, remember } from './lib.mjs';
import { useStore, refresh, connect } from './api.mjs';
import { ToastContainer } from './components/toast.mjs';
import { ConfirmHost } from './components/confirm.mjs';
import { Dot, sessionsStatus, Icon } from './components/ui.mjs';
import { Home } from './views/home.mjs';
import { ProjectView } from './views/project.mjs';
import { TaskView } from './views/task.mjs';
import { SessionPane } from './views/session.mjs';
import { Settings } from './views/settings.mjs';
import { Pair, Unpaired } from './views/pair.mjs';

// #/                              projects
// #/p/:pid                        a project
// #/p/:pid/s/:sid                 a session in the project's checkout
// #/p/:pid/t/:tid[/s/:sid]        a task, on one of its sessions
// #/p/:pid/t/:tid/changes         a task's diff
// #/p/:pid/t/:tid/terminal        a shell in its worktree
// #/settings, #/pair/:code
function parse() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] === 'pair') return { view: 'pair', code: parts[1] };
  if (parts[0] === 'settings') return { view: 'settings' };
  if (parts[0] === 'p' && parts[1]) {
    const r = { view: 'project', projectId: parts[1] };
    if (parts[2] === 's' && parts[3]) return { ...r, view: 'session', sessionId: parts[3] };
    if (parts[2] === 't' && parts[3]) {
      const t = { ...r, view: 'task', taskId: parts[3] };
      if (parts[4] === 's' && parts[5]) return { ...t, sessionId: parts[5] };
      if (parts[4] === 'changes' || parts[4] === 'terminal') return { ...t, tab: parts[4] };
      return t;
    }
    return r;
  }
  return { view: 'home' };
}

function useRoute() {
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const on = () => setRoute(parse());
    window.addEventListener('hashchange', on);
    // A tapped notification asks an open window to go somewhere.
    navigator.serviceWorker?.addEventListener('message', (e) => {
      if (e.data?.type === 'navigate' && e.data.url) location.hash = new URL(e.data.url, location.origin).hash;
    });
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

function Sidebar({ route, onNavigate }) {
  const projects = useStore((s) => s.projects);
  const tasks = useStore((s) => s.tasks);
  const sessions = useStore((s) => s.sessions);
  const approvals = useStore((s) => s.approvals);
  const connected = useStore((s) => s.connected);
  const [folded, setFolded] = useState(() => recall('ai-code:folded', {}));
  const fold = (id) => {
    const next = { ...folded, [id]: !folded[id] };
    setFolded(next);
    remember('ai-code:folded', next);
  };

  return html`
    <nav class="sidebar" aria-label="Projects">
      <div class="side-top">
        <a class="logo" href="#/" onClick=${onNavigate}><span class="logo-mark">◆</span> AI Code</a>
        ${!connected ? html`<span class="badge badge-warn" title="Reconnecting to the server">offline</span>` : null}
      </div>
      ${approvals.length ? html`<a class="side-waiting" href="#/" onClick=${onNavigate}><${Dot} status="waiting" /> ${approvals.length} waiting on you</a>` : null}
      <div class="side-projects">
        ${projects.map((p) => {
          const pt = tasks.filter((t) => t.project_id === p.id && t.state === 'active');
          const ps = sessions.filter((s) => s.project_id === p.id && !s.task_id);
          const open = !folded[p.id];
          return html`
            <div class="side-project" key=${p.id}>
              <div class="side-project-head ${route.projectId === p.id && route.view === 'project' ? 'active' : ''}">
                <button class="fold" type="button" aria-label=${open ? 'Collapse' : 'Expand'} onClick=${() => fold(p.id)}>${open ? '▾' : '▸'}</button>
                <a href=${`#/p/${p.id}`} onClick=${onNavigate}>${p.name}</a>
                ${!open ? html`<${Dot} status=${sessionsStatus(sessions.filter((s) => s.project_id === p.id))} />` : null}
              </div>
              ${open
                ? html`
                    ${pt.map(
                      (t) => html`<a class="side-item ${route.taskId === t.id ? 'active' : ''}" href=${`#/p/${p.id}/t/${t.id}`} onClick=${onNavigate} key=${t.id}>
                        <${Dot} status=${sessionsStatus(sessions.filter((s) => s.task_id === t.id))} /><span>${t.title}</span>
                      </a>`
                    )}
                    ${ps.map(
                      (s) => html`<a class="side-item checkout ${route.sessionId === s.id && route.view === 'session' ? 'active' : ''}" href=${`#/p/${p.id}/s/${s.id}`} onClick=${onNavigate} key=${s.id}>
                        <${Dot} status=${s.status} /><span>${s.title}</span>
                      </a>`
                    )}
                  `
                : null}
            </div>
          `;
        })}
      </div>
      <a class="side-settings ${route.view === 'settings' ? 'active' : ''}" href="#/settings" onClick=${onNavigate}><${Icon} name="gear" /> Settings</a>
    </nav>
  `;
}

function Main({ route }) {
  if (route.view === 'settings') return html`<${Settings} />`;
  if (route.view === 'project') return html`<${ProjectView} key=${route.projectId} projectId=${route.projectId} />`;
  if (route.view === 'task') return html`<${TaskView} key=${route.taskId} projectId=${route.projectId} taskId=${route.taskId} sessionId=${route.sessionId} tab=${route.tab} />`;
  if (route.view === 'session') return html`<div class="session-page"><${SessionPane} key=${route.sessionId} sessionId=${route.sessionId} onArchived=${() => (location.hash = `#/p/${route.projectId}`)} /></div>`;
  return html`<${Home} />`;
}

function title(route, s) {
  if (route.view === 'settings') return 'Settings';
  const p = s.projects.find((x) => x.id === route.projectId);
  if (route.view === 'task') return s.tasks.find((t) => t.id === route.taskId)?.title || 'Task';
  if (route.view === 'session') return s.sessions.find((x) => x.id === route.sessionId)?.title || 'Session';
  return p?.name || 'Projects';
}

function App() {
  const route = useRoute();
  const ready = useStore((s) => s.ready);
  const unauthorized = useStore((s) => s.unauthorized);
  const error = useStore((s) => s.error);
  const heading = useStore((s) => title(route, s));
  const [drawer, setDrawer] = useState(false);

  useEffect(() => {
    document.title = route.view === 'home' ? 'AI Code' : `${heading} · AI Code`;
  }, [heading, route.view]);
  useEffect(() => setDrawer(false), [location.hash]);

  if (route.view === 'pair') return html`<${Pair} code=${route.code} />`;
  if (unauthorized) return html`<${Unpaired} />`;
  if (!ready) return html`<div class="gate muted">Connecting…</div>`;

  const back = route.view === 'task' || route.view === 'session' ? `#/p/${route.projectId}` : route.view === 'project' || route.view === 'settings' ? '#/' : null;

  return html`
    <div class="shell ${drawer ? 'drawer-open' : ''}">
      <${Sidebar} route=${route} onNavigate=${() => setDrawer(false)} />
      ${drawer ? html`<div class="scrim" onClick=${() => setDrawer(false)}></div>` : null}
      <main class="main">
        <header class="topbar">
          <button class="btn ghost icon-only" type="button" aria-label="Menu" onClick=${() => setDrawer(true)}><${Icon} name="menu" /></button>
          ${back ? html`<a class="btn ghost icon-only" href=${back} aria-label="Back"><${Icon} name="back" /></a>` : null}
          <span class="topbar-title">${heading}</span>
        </header>
        ${error ? html`<div class="notice notice-bad">${error}</div>` : null}
        <${Main} route=${route} />
      </main>
      <${ToastContainer} />
      <${ConfirmHost} />
    </div>
  `;
}

render(html`<${App} />`, document.getElementById('app'));
refresh().then(connect);
