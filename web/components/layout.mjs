// App shell: sidebar + header + content area + toast container.
import { html, useState, useEffect } from '../lib.mjs';
import { ToastContainer } from './toast.mjs';

// One 16px stroke icon per destination, drawn inline. Inline rather than a
// sprite or an icon font so there is no extra request, and `currentColor` so
// the icon follows the item's own hover and active colour with no extra rules.
// The shape functions are called at render, so each render gets its own vnodes.
const icon = (shapes) => html`<svg
  class="nav-icon"
  viewBox="0 0 16 16"
  width="16"
  height="16"
  fill="none"
  stroke="currentColor"
  stroke-width="1.5"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>${shapes}</svg>`;

const NAV = [
  { id: 'overview', label: 'Overview', icon: () => icon(html`<rect x="1.75" y="1.75" width="5.5" height="5.5" rx="1.6" /><rect x="8.75" y="1.75" width="5.5" height="5.5" rx="1.6" /><rect x="1.75" y="8.75" width="5.5" height="5.5" rx="1.6" /><rect x="8.75" y="8.75" width="5.5" height="5.5" rx="1.6" />`) },
  { id: 'projects', label: 'Projects', icon: () => icon(html`<path d="M2 5.25A1.75 1.75 0 0 1 3.75 3.5h2.4l1.5 2h4.6A1.75 1.75 0 0 1 14 7.25v4A1.75 1.75 0 0 1 12.25 13h-8.5A1.75 1.75 0 0 1 2 11.25z" />`) },
  { id: 'tasks', label: 'Tasks', icon: () => icon(html`<rect x="2" y="2" width="12" height="12" rx="3" /><path d="M5.4 8.2l1.9 1.9 3.6-4" />`) },
  { id: 'chat', label: 'Chat', icon: () => icon(html`<path d="M2 3a1.75 1.75 0 0 1 1.75-1.75h8.5A1.75 1.75 0 0 1 14 3v7.25A1.75 1.75 0 0 1 12.25 12h-4L4 14.75v-2.75H3.75A1.75 1.75 0 0 1 2 10.25z" />`) },
  { id: 'providers', label: 'Providers', icon: () => icon(html`<rect x="2" y="3" width="12" height="4.5" rx="1.6" /><rect x="2" y="8.5" width="12" height="4.5" rx="1.6" /><circle cx="4.9" cy="5.25" r=".9" fill="currentColor" stroke="none" /><circle cx="4.9" cy="10.75" r=".9" fill="currentColor" stroke="none" />`) },
  { id: 'routing', label: 'Routing', icon: () => icon(html`<path d="M2.5 8h3.1c1.8 0 2.8-1 2.8-2.8V3.5" /><path d="M2.5 8h3.1c1.8 0 2.8 1 2.8 2.8V12.5" /><path d="M7.05 4.9L8.4 3.5l1.35 1.4" /><path d="M7.05 11.1L8.4 12.5l1.35-1.4" />`) },
  { id: 'runs', label: 'Runs', icon: () => icon(html`<circle cx="8" cy="8" r="5.75" /><path d="M8 4.75V8l2.4 1.6" />`) },
  { id: 'usage', label: 'Usage', icon: () => icon(html`<path d="M2 13.25h12" /><path d="M4 13V9.25" /><path d="M8 13V4.75" /><path d="M12 13V7" />`) },
  { id: 'settings', label: 'Settings', icon: () => icon(html`<path d="M2.5 5h4.9M10.9 5h2.6M2.5 11h3M8.5 11h5" /><circle cx="9" cy="5" r="1.5" /><circle cx="6.5" cy="11" r="1.5" />`) },
];

// The sidebar's sections. NAV stays the one list of destinations - the groups
// name slices of it by id, so a new destination cannot be added to the nav
// without appearing in exactly one group.
const NAV_GROUPS = [
  { label: 'Workspace', items: ['overview', 'projects', 'tasks', 'chat'] },
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
                      ${n.icon()}
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
