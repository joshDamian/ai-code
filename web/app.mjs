// The shell: routing, the sidebar of projects and their work, and the gates for a
// device that is not paired.
import { html, render, useEffect, useState, recall, remember } from './lib.mjs';
import { useStore, refresh, connect } from './api.mjs';
import './install.mjs';
import { ToastContainer } from './components/toast.mjs';
import { ConfirmHost } from './components/confirm.mjs';
import { Dot, sessionsStatus, Icon } from './components/ui.mjs';
import { TabBar } from './components/tabbar.mjs';
import { Home, AddProject } from './views/home.mjs';
import { Inbox } from './views/inbox.mjs';
import { SessionsList } from './views/sessions.mjs';
import { Dashboard } from './views/dashboard.mjs';
import { ProjectView } from './views/project.mjs';
import { TaskView } from './views/task.mjs';
import { SessionPane } from './views/session.mjs';
import { Settings } from './views/settings.mjs';
import { Pair, Unpaired } from './views/pair.mjs';

// #/                              projects
// #/inbox                         what is waiting on you
// #/sessions                      every session, flat
// #/dashboard                     what the machine is costing, and who is holding it
// #/p/:pid                        a project
// #/p/:pid/s/:sid                 a session in the project's checkout
// #/p/:pid/t/:tid[/s/:sid]        a task, on one of its sessions
// #/p/:pid/t/:tid/changes         a task's diff
// #/p/:pid/t/:tid/terminal        a shell in its worktree
// #/settings, #/pair/:code
function parse() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] === 'pair') return { view: 'pair', code: parts[1] };
  if (parts[0] === 'inbox') return { view: 'inbox' };
  if (parts[0] === 'sessions') return { view: 'sessions' };
  if (parts[0] === 'dashboard') return { view: 'dashboard' };
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

// The Add project dialog is opened from here but drawn by App: on a phone the sidebar is
// a transformed drawer, and a dialog inside it would slide away with it.
function Sidebar({ route, onNavigate, onAdd }) {
  const projects = useStore((s) => s.projects);
  const tasks = useStore((s) => s.tasks);
  const sessions = useStore((s) => s.sessions);
  const approvals = useStore((s) => s.approvals);
  const connected = useStore((s) => s.connected);
  const [folded, setFolded] = useState(() => recall('bench:folded', {}));
  const fold = (id) => {
    const next = { ...folded, [id]: !folded[id] };
    setFolded(next);
    remember('bench:folded', next);
  };

  return html`
    <nav class="sidebar" aria-label="Projects">
      <div class="side-top">
        <a class="logo" href="#/" onClick=${onNavigate}><img class="logo-mark" src="/icons/favicon.svg" width="26" height="26" alt="" /> Bench</a>
        ${!connected ? html`<span class="badge badge-warn" title="Reconnecting to the server">offline</span>` : null}
      </div>
      ${approvals.length ? html`<a class="side-waiting" href="#/inbox" onClick=${onNavigate}><${Dot} status="waiting" /> ${approvals.length} waiting on you</a>` : null}
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
      <a class="side-settings ${route.view === 'dashboard' ? 'active' : ''}" href="#/dashboard" onClick=${onNavigate}><${Icon} name="activity" /> Dashboard</a>
      <button class="side-settings" type="button" onClick=${() => { onNavigate(); onAdd(); }}><${Icon} name="plus" /> Add project</button>
      <a class="side-settings ${route.view === 'settings' ? 'active' : ''}" href="#/settings" onClick=${onNavigate}><${Icon} name="gear" /> Settings</a>
    </nav>
  `;
}

function Main({ route }) {
  if (route.view === 'settings') return html`<${Settings} />`;
  if (route.view === 'inbox') return html`<${Inbox} />`;
  if (route.view === 'sessions') return html`<${SessionsList} />`;
  if (route.view === 'dashboard') return html`<${Dashboard} />`;
  if (route.view === 'project') return html`<${ProjectView} key=${route.projectId} projectId=${route.projectId} />`;
  if (route.view === 'task') return html`<${TaskView} key=${route.taskId} projectId=${route.projectId} taskId=${route.taskId} sessionId=${route.sessionId} tab=${route.tab} />`;
  if (route.view === 'session') return html`<div class="session-page"><${SessionPane} key=${route.sessionId} sessionId=${route.sessionId} onArchived=${() => (location.hash = `#/p/${route.projectId}`)} /></div>`;
  return html`<${Home} />`;
}

function title(route, s) {
  if (route.view === 'settings') return 'Settings';
  if (route.view === 'inbox') return 'Inbox';
  if (route.view === 'sessions') return 'Sessions';
  if (route.view === 'dashboard') return 'Dashboard';
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
  const waiting = useStore((s) => s.approvals.length);
  const [drawer, setDrawer] = useState(false);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    document.title = route.view === 'home' ? 'Bench' : `${heading} · Bench`;
  }, [heading, route.view]);
  useEffect(() => setDrawer(false), [location.hash]);
  // The number of things waiting on a person, on the app icon itself: a glance at a
  // lock screen says whether it is worth opening. Cleared by passing 0.
  useEffect(() => {
    try {
      navigator.setAppBadge?.(waiting);
    } catch {
      /* not a capability here */
    }
  }, [waiting]);

  if (route.view === 'pair') return html`<${Pair} code=${route.code} />`;
  if (unauthorized) return html`<${Unpaired} />`;
  if (!ready) return html`<div class="gate muted">Connecting…</div>`;

  const back = route.view === 'task' || route.view === 'session' ? `#/p/${route.projectId}` : route.view === 'project' || route.view === 'settings' ? '#/' : null;
  // The tab bar belongs to the top-level screens only. A task or a conversation is a
  // place you went into, and it keeps the height.
  const top = ['home', 'inbox', 'sessions', 'dashboard', 'settings'].includes(route.view);

  return html`
    <div class="shell ${drawer ? 'drawer-open' : ''} ${top ? 'has-tabbar' : ''}">
      <${Sidebar} route=${route} onNavigate=${() => setDrawer(false)} onAdd=${() => setAdding(true)} />
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
      ${top ? html`<${TabBar} route=${route} />` : null}
      ${adding ? html`<${AddProject} onClose=${() => setAdding(false)} />` : null}
      <${ToastContainer} />
      <${ConfirmHost} />
    </div>
  `;
}

render(html`<${App} />`, document.getElementById('app'));
refresh().then(connect);
