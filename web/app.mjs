// Router, global app shell, Preact mount point, global keyboard shortcuts.
import { html, render, Fragment, useState, useEffect, useRef } from './lib.mjs';
import { Layout } from './components/layout.mjs';
import { ShortcutLegend } from './components/kbd.mjs';
import { Overview } from './views/overview.mjs';
import { Projects } from './views/projects.mjs';
import { Tasks } from './views/tasks.mjs';
import { TaskDetail } from './views/task-detail.mjs';
import { Providers } from './views/providers.mjs';
import { Routing } from './views/routing.mjs';
import { Runs } from './views/runs.mjs';
import { Usage } from './views/usage.mjs';
import { Settings } from './views/settings.mjs';

const GO = { o: '#/overview', t: '#/tasks', p: '#/providers', r: '#/runs' };

function parseHash() {
  const hash = location.hash.replace(/^#\/?/, '');
  const parts = hash.split('/').filter(Boolean);
  if (!parts.length) return { view: 'overview' };
  if (parts[0] === 'tasks' && parts[1]) return { view: 'task-detail', id: parts[1] };
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

// The tasks view owns its own new-task form. Announce the intent first so a
// listener can handle and preventDefault it; otherwise click its trigger.
function requestNewTask() {
  const event = new CustomEvent('ai-code:new-task', { bubbles: true, cancelable: true });
  if (!window.dispatchEvent(event)) return;
  const trigger = Array.from(document.querySelectorAll('button')).find((b) => /new task/i.test(b.textContent || ''));
  if (trigger) trigger.click();
}

function App() {
  const [route, setRoute] = useState(parseHash());
  const [legendOpen, setLegendOpen] = useState(false);

  // The keydown listener is bound once; keep the current legend state where it
  // can read it without rebinding on every toggle.
  const legendRef = useRef(false);
  useEffect(() => {
    legendRef.current = legendOpen;
  }, [legendOpen]);

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
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const key = e.key;

      // Esc works from anywhere, including inside a text field.
      if (key === 'Escape') {
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
        const target = GO[key.toLowerCase()];
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

      if (key === 'n' && parseHash().view === 'tasks') {
        e.preventDefault();
        requestNewTask();
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      clearTimeout(pendingTimer);
    };
  }, []);

  let view;
  switch (route.view) {
    case 'overview':
      view = html`<${Overview} navigate=${navigate} />`;
      break;
    case 'projects':
      view = html`<${Projects} navigate=${navigate} />`;
      break;
    case 'tasks':
      view = html`<${Tasks} navigate=${navigate} />`;
      break;
    case 'task-detail':
      view = html`<${TaskDetail} id=${route.id} navigate=${navigate} />`;
      break;
    case 'providers':
      view = html`<${Providers} navigate=${navigate} />`;
      break;
    case 'routing':
      view = html`<${Routing} navigate=${navigate} />`;
      break;
    case 'runs':
      view = html`<${Runs} navigate=${navigate} />`;
      break;
    case 'usage':
      view = html`<${Usage} navigate=${navigate} />`;
      break;
    case 'settings':
      view = html`<${Settings} navigate=${navigate} />`;
      break;
    default:
      view = html`<${Overview} navigate=${navigate} />`;
  }

  const navRoute = route.view === 'task-detail' ? 'tasks' : route.view;

  return html`
    <${Fragment}>
      <${Layout} route=${navRoute}>
        ${view}
      <//>
      <${ShortcutLegend} open=${legendOpen} onClose=${() => setLegendOpen(false)} />
    <//>
  `;
}

render(html`<${App} />`, document.getElementById('app'));
