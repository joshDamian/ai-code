// App shell: sidebar + header + content area + toast container.
import { html, useState, useEffect } from '../lib.mjs';
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

// The sidebar's sections. NAV stays the one list of destinations - the groups
// name slices of it by id, so a new destination cannot be added to the nav
// without appearing in exactly one group.
const NAV_GROUPS = [
  { label: 'Workspace', items: ['overview', 'projects', 'tasks'] },
  { label: 'Ops', items: ['providers', 'routing', 'runs', 'usage'] },
  { label: 'System', items: ['settings'] },
];

const COLLAPSED_KEY = 'ai-code.sidebar-collapsed';

// `title` is the page's own subject (e.g. a task's title), rendered as a
// breadcrumb after the section name; it is optional, so `route` alone still
// labels the header.
export function Layout({ route, title, children }) {
  // Collapsed-ness is a preference, not view state: it survives navigation and
  // reloads so the shell does not snap back open under the user every visit.
  // localStorage throws in some privacy modes, so the read is guarded - a
  // sidebar that cannot remember its state must still render.
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSED_KEY) === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0');
    } catch {
      // Storage unavailable (private mode, quota) - the in-memory state is
      // still correct for this session, so failing to persist is not an error.
    }
  }, [collapsed]);

  const current = NAV.find((n) => n.id === route);

  return html`
    <div class="app-shell ${collapsed ? 'collapsed' : ''}">
      <aside class="sidebar">
        <div class="logo">
          <div class="logo-text">
            <div class="logo-title">AI CODE</div>
            <div class="logo-sub muted">Mission Control</div>
          </div>
          <button
            class="sidebar-toggle"
            type="button"
            aria-label=${collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded=${!collapsed}
            onClick=${() => setCollapsed((v) => !v)}
          >${collapsed ? '»' : '«'}</button>
        </div>
        ${NAV_GROUPS.map(
          (g) => html`
            <div class="nav-group" key=${g.label}>
              <div class="nav-group-label">${g.label}</div>
              <nav class="nav">
                ${g.items.map((id) => {
                  const n = NAV.find((x) => x.id === id);
                  return html`
                    <a key=${n.id} href="#/${n.id}" class="nav-item ${route === n.id ? 'active' : ''}" title=${n.label}>
                      <span class="nav-item-label">${n.label}</span>
                    </a>
                  `;
                })}
              </nav>
            </div>
          `
        )}
      </aside>
      <div class="main-col">
        <header class="app-header">
          <div class="header-title">
            ${current ? current.label : ''}
            ${title ? html`<span class="header-sep">/</span><span class="header-crumb">${title}</span>` : null}
          </div>
        </header>
        <main class="content">${children}</main>
      </div>
      <${ToastContainer} />
    </div>
  `;
}
