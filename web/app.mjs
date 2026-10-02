// Router, global app shell, Preact mount point, global keyboard shortcuts.
import { html, render, Fragment, useState, useEffect, useRef, useCallback, remember, conversationsHref, CONVERSATIONS_PLACE } from './lib.mjs';
import { Layout } from './components/layout.mjs';
import { ShortcutLegend } from './components/kbd.mjs';
import { CommandPalette } from './components/command-palette.mjs';
import { ConfirmHost } from './components/confirm.mjs';
import { ApprovalDock } from './components/approvals.mjs';
import { requestPermission, notifyRunEnd } from './components/notify.mjs';
import { Overview } from './views/overview.mjs';
import { Projects } from './views/projects.mjs';
import { Project } from './views/project.mjs';
import { Tasks } from './views/tasks.mjs';
import { TaskDetail } from './views/task-detail.mjs';
import { Chat } from './views/chat.mjs';
import { Sessions } from './views/sessions.mjs';
import { Providers } from './views/providers.mjs';
import { Routing } from './views/routing.mjs';
import { Runs } from './views/runs.mjs';
import { Usage } from './views/usage.mjs';
import { Settings, TokenGate } from './views/settings.mjs';
import { ServerPanel } from './components/server-panel.mjs';
import { notificationsUrl } from './api.mjs';

// `c` and `s` both reach conversations - c was chat's, and chat is one of them now -
// and return to where the person last was in them, as the sidebar link does.
const GO = { o: '#/overview', t: '#/tasks', c: conversationsHref, s: conversationsHref, p: '#/providers', r: '#/runs' };

function parseHash() {
  const hash = location.hash.replace(/^#\/?/, '');
  const parts = hash.split('/').filter(Boolean);
  if (!parts.length) return { view: 'overview' };
  if (parts[0] === 'tasks' && parts[1]) return { view: 'task-detail', id: parts[1] };
  if (parts[0] === 'chat' && parts[1]) return { view: 'chat-detail', id: parts[1] };
  if (parts[0] === 'sessions' && parts[1]) return { view: 'session-detail', id: parts[1] };
  if (parts[0] === 'project' && parts[1]) return { view: 'project', id: parts[1] };
  // One run's detail, opened over the list: what a link to a particular run points at.
  if (parts[0] === 'runs' && parts[1]) return { view: 'runs', id: parts[1] };
  // The add form opened on arrival, for the links that exist to add a project.
  if (parts[0] === 'projects' && parts[1] === 'new') return { view: 'projects', intent: 'new' };
  return { view: parts[0] };
}

function navigate(hash) {
  if (location.hash === hash) {
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    location.hash = hash;
  }
}

// Anything the user can type into. Shortcuts must never fire while one of these
// has focus - that is how "g", "n" and "?" end up as text in a search box.
function isTypingTarget(el) {
  if (!el || !el.tagName) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return el.isContentEditable === true;
}

// Whichever view provides a search field owns its markup, so look for the
// conventional hooks rather than assuming one.
function findSearchField() {
  return document.querySelector('input[type="search"], [data-search], .search-input');
}

function App() {
  const [route, setRoute] = useState(parseHash());
  const [legendOpen, setLegendOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // The breadcrumb's subject: only the page itself knows what it is showing, so a
  // view that has one hands it up. Null everywhere else, and nulled on the way out
  // so a task's title cannot follow the user to another view.
  const [pageTitle, setPageTitle] = useState(null);
  // Set by the first 401 from any call. Desktop never sees it - the server exempts
  // loopback, so no request from this machine can be refused for the want of a token.
  // A phone sees it once, before it has paired.
  const [unpaired, setUnpaired] = useState(false);
  // How the last API call found the server, reported on every transition. Null until
  // something has been asked, so a page that has just rendered does not flash a
  // stopped panel before its first request has had a chance to fail.
  const [link, setLink] = useState(null);
  // Derived here rather than beside the effect that sets them, because the effects
  // below read both while rendering - a const declared after them would be in the
  // temporal dead zone when their dependency arrays are evaluated.
  const serverDown = link ? !link.up : false;
  const supervisorUp = !!link?.supervisor;

  // The keydown listener is bound once; keep the current legend state where it
  // can read it without rebinding on every toggle.
  const legendRef = useRef(false);
  useEffect(() => {
    legendRef.current = legendOpen;
  }, [legendOpen]);

  // Likewise for the palette, whose Escape key would otherwise be handled as "clear
  // the search box" by the branch below.
  const paletteRef = useRef(false);
  useEffect(() => {
    paletteRef.current = paletteOpen;
  }, [paletteOpen]);

  // New task is the palette's one action that is not a navigation: the form belongs
  // to the tasks view, so the route is set and an intent is raised. The view opens
  // its form when the intent changes, which means the request survives the route
  // change without anybody guessing when the view has finished rendering - the
  // counter is the signal, and the view is the only thing that reads it.
  const [newTaskIntent, setNewTaskIntent] = useState(0);
  const newTask = useCallback(() => {
    navigate('#/tasks');
    setNewTaskIntent((n) => n + 1);
  }, []);
  const consumeNewTask = useCallback(() => setNewTaskIntent(0), []);

  // The keydown listener is bound once, so it reaches `newTask` through a ref rather
  // than through its closure - which would be the first render's version, and the
  // first render's version is the one that captured an empty intent counter.
  const newTaskRef = useRef(() => {});
  useEffect(() => {
    newTaskRef.current = newTask;
  }, [newTask]);

  // Every place inside Conversations is remembered as it is reached, so leaving for
  // another view and coming back lands where the person left. The chat list is the
  // conversations list now, so it is remembered as that.
  useEffect(() => {
    if (route.view === 'sessions' || route.view === 'session-detail' || route.view === 'chat-detail') remember(CONVERSATIONS_PLACE, location.hash);
    else if (route.view === 'chat') remember(CONVERSATIONS_PLACE, '#/sessions');
  }, [route]);

  useEffect(() => {
    function onHashChange() {
      setRoute(parseHash());
    }
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    let pending = false;
    let pendingTimer = 0;

    function clearPending() {
      pending = false;
      clearTimeout(pendingTimer);
    }

    function onKeyDown(e) {
      const key = e.key;

      // The one shortcut that is pressed with a modifier held, so it is matched
      // before the branch below drops every other modified key. `key` rather than
      // `code` because Ctrl+K and Cmd+K are the same intent on either platform.
      if ((e.metaKey || e.ctrlKey) && !e.altKey && key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }

      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;

      // Esc works from anywhere, including inside a text field.
      if (key === 'Escape') {
        if (paletteRef.current) {
          setPaletteOpen(false);
          return;
        }
        if (legendRef.current) {
          setLegendOpen(false);
          return;
        }
        const el = document.activeElement;
        if (isTypingTarget(el)) {
          if (el.value) {
            el.value = '';
            el.dispatchEvent(new Event('input', { bubbles: true }));
          } else {
            el.blur();
          }
        }
        return;
      }

      if (isTypingTarget(e.target)) return;

      if (pending) {
        clearPending();
        const go = GO[key.toLowerCase()];
        const target = typeof go === 'function' ? go() : go;
        if (target) {
          e.preventDefault();
          navigate(target);
        }
        return;
      }

      if (key === 'g') {
        pending = true;
        pendingTimer = setTimeout(() => {
          pending = false;
        }, 1200);
        return;
      }

      if (key === '?') {
        e.preventDefault();
        setLegendOpen((v) => !v);
        return;
      }

      if (key === '/') {
        const field = findSearchField();
        if (field) {
          e.preventDefault();
          field.focus();
          if (typeof field.select === 'function') field.select();
        }
        return;
      }

      if (key === 'n') {
        e.preventDefault();
        newTaskRef.current();
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      clearTimeout(pendingTimer);
    };
  }, []);

  // Global run-completion watcher. An SSE stream from the server pushes a
  // frame when any run finishes, so the browser can fire a notification
  // without polling.
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  useEffect(() => {
    // Nothing to watch for while unpaired: the stream would 401 and retry forever,
    // and every frame it did carry would be for a session this browser cannot read.
    // And nothing while the server is down: EventSource reconnects on a timer, so a
    // stream opened against a stopped server is a request every few seconds, forever,
    // against a port that has nothing behind it.
    if (unpaired || serverDown) return undefined;
    requestPermission();
    const es = new EventSource(notificationsUrl());
    es.addEventListener('run-end', (e) => {
      try {
        const { run, task } = JSON.parse(e.data);
        notifyRunEnd(run, task, (h) => navigateRef.current(h));
      } catch {
        // Malformed frame; ignore.
      }
    });
    return () => es.close();
  }, [unpaired, serverDown]);

  // A push notification tapped while the app is already open. The service worker
  // finds the window rather than opening a second copy, and this is what routes that
  // window to the task the notification was about.
  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.serviceWorker) return undefined;
    const onMessage = (e) => {
      const hash = typeof e.data?.url === 'string' ? e.data.url.replace(/^[^#]*/, '') : '';
      if (e.data?.type === 'navigate' && hash) navigateRef.current(hash);
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    const onUnauthorized = () => setUnpaired(true);
    window.addEventListener('ai-code:unauthorized', onUnauthorized);
    return () => window.removeEventListener('ai-code:unauthorized', onUnauthorized);
  }, []);

  useEffect(() => {
    const onConnectivity = (e) => setLink(e.detail);
    window.addEventListener('ai-code:connectivity', onConnectivity);
    return () => window.removeEventListener('ai-code:connectivity', onConnectivity);
  }, []);

  // The pairing screen, and the one early return in this component. It replaces the
  // whole shell rather than sitting inside it: an unpaired browser can render no view
  // at all, so a sidebar of destinations that all 401 would be nine links to the same
  // refusal.
  if (unpaired) return html`<${TokenGate} />`;

  let view;
  switch (route.view) {
    case 'overview':
      view = html`<${Overview} navigate=${navigate} onNewTask=${newTask} />`;
      break;
    case 'projects':
      view = html`<${Projects} navigate=${navigate} openForm=${route.intent === 'new'} />`;
      break;
    case 'project':
      view = html`<${Project} id=${route.id} navigate=${navigate} onTitle=${setPageTitle} />`;
      break;
    case 'tasks':
      view = html`<${Tasks} navigate=${navigate} openForm=${newTaskIntent} onFormOpened=${consumeNewTask} />`;
      break;
    case 'task-detail':
      view = html`<${TaskDetail} id=${route.id} navigate=${navigate} onTitle=${setPageTitle} />`;
      break;
    // The chat list is the conversations list now; a chat still opens on its own.
    case 'chat':
      view = html`<${Sessions} navigate=${navigate} onTitle=${setPageTitle} />`;
      break;
    case 'chat-detail':
      view = html`<${Chat} id=${route.id} navigate=${navigate} onTitle=${setPageTitle} />`;
      break;
    case 'sessions':
      view = html`<${Sessions} navigate=${navigate} onTitle=${setPageTitle} />`;
      break;
    case 'session-detail':
      view = html`<${Sessions} id=${route.id} navigate=${navigate} onTitle=${setPageTitle} />`;
      break;
    case 'providers':
      view = html`<${Providers} navigate=${navigate} />`;
      break;
    case 'routing':
      view = html`<${Routing} navigate=${navigate} />`;
      break;
    case 'runs':
      view = html`<${Runs} navigate=${navigate} runId=${route.id} />`;
      break;
    case 'usage':
      view = html`<${Usage} navigate=${navigate} />`;
      break;
    case 'settings':
      view = html`<${Settings} navigate=${navigate} />`;
      break;
    default:
      view = html`<${Overview} navigate=${navigate} onNewTask=${newTask} />`;
  }

  // The server this page was loaded from is gone. Every view would render an error per
  // call it makes - and keep making them on its own poll - so the routed view is
  // replaced by the one screen that can say what happened and offer to fix it.
  if (serverDown) view = html`<${ServerPanel} supervisorUp=${supervisorUp} />`;

  const navRoute = route.view === 'task-detail' ? 'tasks' : route.view === 'chat-detail' || route.view === 'chat' ? 'sessions' : route.view === 'session-detail' ? 'sessions' : route.view === 'project' ? 'projects' : route.view;
  const title = route.view === 'task-detail' || route.view === 'chat-detail' || route.view === 'session-detail' || route.view === 'project' ? pageTitle : null;

  return html`
    <${Fragment}>
      <${Layout}
        route=${navRoute}
        title=${title}
        serverDown=${serverDown}
        onOpenPalette=${() => setPaletteOpen(true)}
        onNewTask=${newTask}
      >
        ${view}
      <//>
      <${ShortcutLegend} open=${legendOpen} onClose=${() => setLegendOpen(false)} />
      <${CommandPalette}
        open=${paletteOpen}
        onClose=${() => setPaletteOpen(false)}
        navigate=${navigate}
        onNewTask=${newTask}
      />
      ${/* Mounted once here, the way the toast stack is. A dialog any view can
           raise, and none of them has to render it. */ ''}
      <${ConfirmHost} />
      ${/* Any conversation's permission prompt, answerable from every screen. */ ''}
      <${ApprovalDock} route=${route} navigate=${navigate} paused=${unpaired || serverDown} />
    <//>
  `;
}

render(html`<${App} />`, document.getElementById('app'));
