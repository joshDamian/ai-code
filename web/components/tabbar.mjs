// The phone's own navigation: five destinations, always at the bottom, where a thumb
// already is. The sidebar is still there in the drawer for the full project tree, but a
// person moving between the inbox, the sessions, what the machine is doing, the projects
// and settings should never have to open it. Shown only on top-level screens - a task or
// a conversation keeps the whole height and gets back out with the bar's back button.
import { html } from '../lib.mjs';
import { useStore } from '../api.mjs';
import { Icon } from './ui.mjs';

const TABS = [
  { id: 'inbox', label: 'Inbox', href: '#/inbox', icon: 'inbox' },
  { id: 'sessions', label: 'Sessions', href: '#/sessions', icon: 'list' },
  { id: 'dashboard', label: 'Dashboard', href: '#/dashboard', icon: 'activity' },
  { id: 'home', label: 'Projects', href: '#/', icon: 'folder' },
  { id: 'settings', label: 'Settings', href: '#/settings', icon: 'gear' },
];

export function TabBar({ route }) {
  const waiting = useStore((s) => s.approvals.length);
  const working = useStore((s) => s.sessions.filter((x) => x.status === 'running').length);
  const badgeFor = (id) => (id === 'inbox' && waiting ? waiting : id === 'sessions' && working ? working : 0);
  const active = route.view === 'home' ? 'home' : route.view;

  return html`
    <nav class="tabbar" aria-label="Primary">
      ${TABS.map((t) => {
        const n = badgeFor(t.id);
        return html`<a class="tabbar-item ${active === t.id ? 'active' : ''}" href=${t.href} key=${t.id}>
          <span class="tabbar-icon">
            <${Icon} name=${t.icon} size=${22} />
            ${n ? html`<span class="tabbar-badge">${n > 9 ? '9+' : n}</span>` : null}
          </span>
          <span class="tabbar-label">${t.label}</span>
        </a>`;
      })}
    </nav>
  `;
}
