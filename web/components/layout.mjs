// App shell: sidebar + header + content area + toast container.
import { html } from '../lib.mjs';
import { ToastContainer } from './toast.mjs';

const NAV = [
  { id: 'overview', label: 'Overview' },
  { id: 'projects', label: 'Projects' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'providers', label: 'Providers' },
  { id: 'routing', label: 'Routing' },
  { id: 'runs', label: 'Runs' },
  { id: 'usage', label: 'Usage' },
  { id: 'settings', label: 'Settings' },
];

export function Layout({ route, children }) {
  const current = NAV.find((n) => n.id === route);
  return html`
    <div class="app-shell">
      <aside class="sidebar">
        <div class="logo">
          <div class="logo-title">AI CODE</div>
          <div class="logo-sub muted">Mission Control</div>
        </div>
        <nav class="nav">
          ${NAV.map(
            (n) => html`
              <a key=${n.id} href="#/${n.id}" class="nav-item ${route === n.id ? 'active' : ''}">${n.label}</a>
            `
          )}
        </nav>
      </aside>
      <div class="main-col">
        <header class="app-header">
          <div class="header-title">${current ? current.label : ''}</div>
        </header>
        <main class="content">${children}</main>
      </div>
      <${ToastContainer} />
    </div>
  `;
}
