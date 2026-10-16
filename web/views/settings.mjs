// Providers, defaults, devices, notifications and the server's health.
import { html, useEffect, useRef, useState, recall, remember, formatCost, formatDuration } from '../lib.mjs';
import { api, useStore, refresh, reconnectNow } from '../api.mjs';
import { showToast } from '../components/toast.mjs';
import { confirmAction } from '../components/confirm.mjs';
import { Toggle } from '../components/form.mjs';
import { Time } from '../components/time.mjs';
import { ModelPicker, ModePicker, EffortPicker } from '../components/ui.mjs';
import { useInstall } from '../install.mjs';
import { ThemeTrigger } from '../components/theme-picker.mjs';

const toast = (e) => showToast(e.message || String(e), 'error');

export function Settings() {
  const groups = useRef(null);
  return html`
    <div class="page settings">
      <header class="page-header"><h1>Settings</h1><${ThemeTrigger} align="end" /></header>
      <div class="set-layout">
        <${SectionNav} groups=${groups} />
        <div class="set-groups" ref=${groups}>
          <${Defaults} />
          <${Providers} />
          <${Notifications} />
          <${Devices} />
          <${InstallApp} />
          <${Usage} />
          <${Doctor} />
          <${Server} />
        </div>
      </div>
    </div>
  `;
}

/**
 * The groups on the page, to jump between on a wide screen. Read from the page rather
 * than listed here, because Install and Spend come and go with what they find. Buttons,
 * not `#` links: the hash is the router's.
 */
function SectionNav({ groups }) {
  const [items, setItems] = useState([]);
  const [current, setCurrent] = useState(null);
  useEffect(() => {
    const root = groups.current;
    if (!root) return;
    const read = () => {
      const found = [...root.querySelectorAll(':scope > .set-group')].map((el) => ({ id: el.id, title: el.dataset.title }));
      setItems(found);
      setCurrent((c) => c || found[0]?.id || null);
    };
    read();
    const mo = new MutationObserver(read);
    mo.observe(root, { childList: true });
    return () => mo.disconnect();
  }, []);
  useEffect(() => {
    if (!items.length) return;
    // The first group, in page order, that reaches into the top third of the screen.
    const inView = new Set();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) e.isIntersecting ? inView.add(e.target.id) : inView.delete(e.target.id);
        const first = items.find((g) => inView.has(g.id));
        if (first) setCurrent(first.id);
      },
      { rootMargin: '0px 0px -66% 0px' }
    );
    for (const { id } of items) {
      const el = document.getElementById(id);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, [items]);
  const go = (id) => {
    setCurrent(id);
    document.getElementById(id)?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  };
  return html`
    <nav class="set-nav" aria-label="Settings sections">
      ${items.map((g) => html`<button type="button" class="set-nav-item ${current === g.id ? 'on' : ''}" aria-current=${current === g.id ? 'true' : null} key=${g.id} onClick=${() => go(g.id)}>${g.title}</button>`)}
    </nav>
  `;
}

/** One group of settings: a heading, a line of what it controls, then its rows. */
function Group({ id, title, hint, children }) {
  return html`
    <section class="set-group" id=${`set-${id}`} data-title=${title} aria-labelledby=${`set-${id}-h`}>
      <header class="set-head">
        <h2 id=${`set-${id}-h`}>${title}</h2>
        ${hint ? html`<p class="set-desc">${hint}</p>` : null}
      </header>
      <div class="set-rows">${children}</div>
    </section>
  `;
}

/**
 * A setting: what it does on the left, its control on the right edge. `stack` puts a
 * control that needs the width - a path, a pair of selects - under the label on a phone;
 * `wide` does it everywhere. `after` spans the row, under both.
 */
function Row({ label, hint, children, stack, wide, after }) {
  return html`
    <div class="set-row ${stack ? 'stack' : ''} ${wide ? 'wide' : ''}">
      <div class="set-text">
        <span class="set-label">${label}</span>
        ${hint ? html`<span class="set-hint">${hint}</span>` : null}
      </div>
      ${children ? html`<div class="set-control">${children}</div>` : null}
      ${after}
    </div>
  `;
}

/** Placeholder rows at a real row's height, for a group whose data is on its way. */
function SkeletonRows({ n = 2 }) {
  return html`${Array.from({ length: n }, (_, i) => html`<div class="set-row" key=${i} aria-hidden="true"><div class="set-text"><span class="skeleton" style="width:40%"></span><span class="skeleton sm" style="width:65%"></span></div></div>`)}`;
}

/** In place of a group's rows when they could not be loaded: a row of its own, so it says where. */
function LoadFailed({ what, retry }) {
  return html`
    <div class="set-row set-failed" role="alert">
      <div class="set-text">
        <span class="set-label">Couldn't load ${what}</span>
        <span class="set-hint">Check that the server is running, then try again.</span>
      </div>
      <div class="set-control"><button class="btn sm secondary" type="button" onClick=${retry}>Try again</button></div>
    </div>
  `;
}

/**
 * Defaults save as they change. Each says so beside its control for two seconds, and a
 * save that fails says so in its own row, since a toast does not say which one it was.
 */
function useSaves(save) {
  const [st, setSt] = useState({});
  const run = (key, body) =>
    save(body).then(
      () => {
        setSt((s) => ({ ...s, [key]: 'saved' }));
        setTimeout(() => setSt((s) => (s[key] === 'saved' ? { ...s, [key]: null } : s)), 2000);
      },
      (e) => setSt((s) => ({ ...s, [key]: { error: e.message || String(e), retry: () => run(key, body) } }))
    );
  const saved = (key) => (st[key] === 'saved' ? html`<span class="set-saved" role="status">Saved</span>` : null);
  const failed = (key) =>
    st[key]?.error
      ? html`<p class="set-error" role="alert"><span>Couldn't save: ${st[key].error}</span><button class="btn sm ghost" type="button" onClick=${st[key].retry}>Try again</button></p>`
      : null;
  return { run, saved, failed };
}

function Defaults() {
  const providers = useStore((s) => s.providers);
  const d = useStore((s) => s.defaults);
  const { run, saved, failed } = useSaves((b) => api.setDefaults(b).then(refresh));
  return html`
    <${Group} id="defaults" title="Defaults" hint="What a new session starts with. A session can change any of these for itself.">
      <${Row} label="Model" hint="The provider and model new sessions use." wide after=${failed('model')}>
        ${saved('model')}<${ModelPicker} providers=${providers} value=${{ providerId: d.providerId, modelId: d.modelId }} onChange=${(v) => run('model', v)} />
      <//>
      <${Row} label="Effort" hint="How long Claude thinks before it answers." stack after=${failed('effort')}>
        ${saved('effort')}<${EffortPicker} value=${d.effort} onChange=${(effort) => run('effort', { effort })} />
      <//>
      <${Row} label="Permissions" hint="What Claude may do before it asks you." stack after=${failed('mode')}>
        ${saved('mode')}<${ModePicker} value=${d.mode} onChange=${(mode) => run('mode', { mode })} />
      <//>
      <${ProjectsFolder} value=${d.projectsDir} onSave=${(projectsDir) => run('projectsDir', { projectsDir })} saved=${saved('projectsDir')} failed=${failed('projectsDir')} />
      <p class="set-note">Sessions load the project's <code>.claude/</code> settings and CLAUDE.md, and your own <code>~/.claude/CLAUDE.md</code>. Your user <code>settings.json</code> is not loaded, so its <code>env</code> cannot redirect a provider.</p>
    <//>
  `;
}

function ProjectsFolder({ value, onSave, saved, failed }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return html`
    <${Row} label="Projects folder" hint="Where cloned and new projects go, unless you choose somewhere else when adding one." wide after=${failed}>
      <input class="input mono-sm" aria-label="Projects folder" value=${text} onInput=${(e) => setText(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && onSave(text)} />
      ${text !== value ? html`<button class="btn sm secondary" type="button" onClick=${() => onSave(text)}>Save</button>` : saved}
    <//>
  `;
}

function Providers() {
  const providers = useStore((s) => s.providers);
  const [testing, setTesting] = useState(null);
  const [open, setOpen] = useState(null);
  const test = async (p) => {
    setTesting(p.id);
    const r = await api.testProvider(p.id, null).catch((e) => ({ ok: false, error: e.message }));
    setTesting(null);
    showToast(r.ok ? `${p.name}: OK in ${(r.ms / 1000).toFixed(1)}s` : `${p.name}: ${r.error}`, r.ok ? 'success' : 'error');
  };
  return html`
    <${Group} id="providers" title="Providers" hint=${html`Where a session's API calls go. A hosted provider reads its key from the <code>env</code> file in Bench's data folder (<code>~/.bench/env</code> by default), or the server's environment.`}>
      ${providers.map(
        (p) => html`
          <${Row}
            key=${p.id}
            label=${p.name}
            hint=${p.ready ? `${p.models.filter((m) => m.enabled).length} models` : p.reason}
            after=${open === p.id
              ? html`<div class="models">
                  ${p.models.map(
                    (m) => html`<label class="model-row" key=${m.id}>
                      <input type="checkbox" checked=${m.enabled} onChange=${(e) => api.updateModel(m.id, { enabled: e.target.checked }).then(refresh).catch(toast)} />
                      <span>${m.display_name || m.name}</span>
                      <span class="muted mono-sm">${m.input_cost_per_mtok != null ? `$${m.input_cost_per_mtok} / $${m.output_cost_per_mtok} per M` : ''}</span>
                    </label>`
                  )}
                </div>`
              : null}
          >
            <button class="btn sm ghost" type="button" aria-expanded=${open === p.id ? 'true' : 'false'} onClick=${() => setOpen(open === p.id ? null : p.id)}>${open === p.id ? 'Hide models' : 'Models'}</button>
            <button class="btn sm secondary" type="button" disabled=${!p.ready || testing === p.id} onClick=${() => test(p)}>${testing === p.id ? 'Testing…' : 'Test'}</button>
            <${Toggle} hideLabel label=${`Enable ${p.name}`} checked=${p.enabled} onChange=${(on) => api.updateProvider(p.id, { enabled: on }).then(refresh).catch(toast)} />
          <//>
        `
      )}
    <//>
  `;
}

function Devices() {
  const me = useStore((s) => s.me);
  const [devices, setDevices] = useState(null);
  const [failed, setFailed] = useState(false);
  const [pairing, setPairing] = useState(null);
  const load = () =>
    api.devices().then(
      (d) => {
        setDevices(d);
        setFailed(false);
      },
      () => setFailed(true)
    );
  useEffect(() => {
    load();
  }, []);
  return html`
    <${Group} id="devices" title="Devices" hint=${html`This machine's own browser needs no pairing. Any other device pairs once with a one-time link, reached over your tailnet (<code>bench share</code>).`}>
      ${failed && !devices
        ? html`<${LoadFailed} what="devices" retry=${load} />`
        : !devices
          ? html`<${SkeletonRows} n=${1} />`
          : devices.map(
              (d) => html`<${Row}
                key=${d.id}
                label=${html`${d.name}${me?.device?.id === d.id ? html` <span class="badge badge-info">this device</span>` : null}`}
                hint=${html`Seen ${d.last_seen_at ? html`<${Time} at=${d.last_seen_at} />` : 'never'}`}
              >
                <button class="btn sm danger" type="button" onClick=${async () => (await confirmAction({ title: `Unpair ${d.name}?`, confirmLabel: 'Unpair', tone: 'danger' })) && api.revokeDevice(d.id).then(load).catch(toast)}>Unpair</button>
              <//>`
            )}
      <${Row}
        label=${devices?.length ? 'Pair another device' : 'Pair a device'}
        hint="Makes a one-time link that works for 10 minutes."
        after=${pairing
          ? html`<div class="pairing">
              ${pairing.qr ? html`<div class="qr" dangerouslySetInnerHTML=${{ __html: pairing.qr }}></div>` : null}
              <div class="stack">
                ${pairing.urls.length
                  ? pairing.urls.map((u) => html`<code class="pair-url">${u}</code>`)
                  : html`<p>No address for other devices is known. On the server run <code>bench share</code>, or set <code>BENCH_PUBLIC_URL</code>, then pair again. Code: <code>${pairing.code}</code></p>`}
                <p class="muted">Open it on the other device within 10 minutes. It works once.</p>
              </div>
            </div>`
          : null}
      >
        <button class="btn sm secondary" type="button" onClick=${() => api.pairing().then(setPairing).catch(toast)}>Pair a device</button>
      <//>
    <//>
  `;
}

function urlBase64ToUint8Array(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

function InstallApp() {
  const { state, install } = useInstall();
  const [why, setWhy] = useState(null);
  useEffect(() => {
    // What the browser can see, for when it offers no install: the usual reasons.
    setWhy({
      secure: window.isSecureContext,
      worker: !!navigator.serviceWorker?.controller,
      browser: (navigator.userAgentData?.brands || []).map((b) => b.brand).filter((b) => !/Not.?A.?Brand/i.test(b)).join(', ') || navigator.userAgent,
    });
  }, []);
  if (state === 'app') return null;
  return html`
    <${Group} id="install" title="Install">
      ${state === 'ready'
        ? html`<${Row} label="Install Bench on this device" hint="Its own icon, its own window, no browser bar.">
            <button class="btn sm secondary" type="button" onClick=${() => install().then((o) => o === 'accepted' && showToast('Installing Bench', 'success')).catch(toast)}>Install Bench</button>
          <//>`
        : state === 'installed'
          ? html`<${Row} label="Installed" hint="Open Bench from its icon." />`
          : html`<${Row}
              label="Not offered by this browser"
              hint="If Bench is already installed here, open it from its icon. Otherwise the browser has decided not to: in Chrome that is an Incognito tab, a managed or work profile, or a browser opened inside another app."
              after=${why ? html`<p class="set-note mono-sm">HTTPS: ${why.secure ? 'yes' : 'no'} · Service worker in control: ${why.worker ? 'yes' : 'no (reload once)'} · ${why.browser}</p>` : null}
            />`}
    <//>
  `;
}

const CHOICES_KEY = 'bench:push:choices';
const CHOICE_FIELDS = [
  { key: 'approvals', label: 'When Claude needs an approval', hint: 'Allow or Deny from the notification itself' },
  { key: 'finished', label: 'When a turn finishes' },
  { key: 'errors', label: 'When a turn stops with an error' },
];

function Notifications() {
  const key = useStore((s) => s.push);
  const [sub, setSub] = useState(undefined);
  const [choices, setChoices] = useState(() => recall(CHOICES_KEY, { approvals: true, finished: true, errors: true }));
  const supported = 'serviceWorker' in navigator && 'PushManager' in window;
  useEffect(() => {
    if (!supported) return;
    navigator.serviceWorker.ready.then((r) => r.pushManager.getSubscription()).then(setSub).catch(() => setSub(null));
  }, []);
  const enable = async () => {
    try {
      if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notifications are blocked for this site');
      const reg = await navigator.serviceWorker.ready;
      const s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) });
      // What this device wants rides with the subscription, since the worker that
      // receives the push has no localStorage of its own to read it from.
      await api.pushSubscribe({ ...s.toJSON(), choices });
      setSub(s);
      showToast('Notifications on', 'success');
    } catch (e) {
      toast(e);
    }
  };
  const disable = async () => {
    await api.pushUnsubscribe(sub.endpoint).catch(() => {});
    await sub.unsubscribe().catch(() => {});
    setSub(null);
  };
  const setChoice = (k, v) => {
    const next = { ...choices, [k]: v };
    setChoices(next);
    remember(CHOICES_KEY, next);
    if (sub) api.pushChoices(sub.endpoint, next).catch(toast);
  };
  return html`
    <${Group} id="notifications" title="Notifications" hint="A push to this device when Claude needs an approval or finishes a turn. Each device chooses for itself.">
      ${!supported || !key
        ? html`<${Row} label="Not available here" hint="Push needs HTTPS (the tailnet address) and, on iOS, the app added to the home screen." />`
        : sub
          ? html`
              ${CHOICE_FIELDS.map(
                (f) => html`<${Row} key=${f.key} label=${f.label} hint=${f.hint}>
                  <${Toggle} hideLabel label=${f.label} checked=${choices[f.key] !== false} onChange=${(on) => setChoice(f.key, on)} />
                <//>`
              )}
              <${Row} label="On for this device" hint="Stops every push to this browser.">
                <button class="btn sm secondary" type="button" onClick=${disable}>Turn off on this device</button>
              <//>`
          : html`<${Row} label="Off for this device" hint="Your browser asks for permission first.">
              <button class="btn sm secondary" type="button" disabled=${sub === undefined} onClick=${enable}>Turn on for this device</button>
            <//>`}
    <//>
  `;
}

function Usage() {
  const projects = useStore((s) => s.projects);
  const [rows, setRows] = useState(null);
  useEffect(() => {
    api.usage().then(setRows).catch(() => setRows([]));
  }, []);
  if (!rows?.length) return null;
  const by = new Map();
  for (const r of rows) by.set(r.project_id, (by.get(r.project_id) || 0) + r.cost);
  return html`
    <${Group} id="spend" title="Spend" hint="Estimates from Claude Code, at each model's published price. A subscription is not billed per token.">
      ${[...by].map(([pid, cost]) => html`<${Row} key=${pid} label=${projects.find((p) => p.id === pid)?.name || 'Removed project'}><span class="set-value mono-sm">${formatCost(cost)}</span><//>`)}
    <//>
  `;
}

function Doctor() {
  const [checks, setChecks] = useState(null);
  const [failed, setFailed] = useState(false);
  const load = () => {
    setFailed(false);
    api.doctor().then(
      (r) => setChecks(r.checks),
      () => setFailed(true)
    );
  };
  useEffect(() => {
    load();
  }, []);
  return html`
    <${Group} id="diagnostics" title="Diagnostics" hint="What Bench needs on this machine, and whether it found it.">
      ${checks
        ? html`<div class="checks">${checks.map((c) => html`<div class="check-row"><span class=${c.ok ? 'good' : c.optional ? 'muted' : 'bad'}>${c.ok ? '✓' : c.optional ? '–' : '✗'}</span><span class="check-name">${c.name}</span><span class="muted">${c.detail}</span></div>`)}</div>`
        : failed
          ? html`<${LoadFailed} what="diagnostics" retry=${load} />`
          : html`<${SkeletonRows} n=${3} />`}
    <//>
  `;
}

/** Resolves once the server answers again, after it was seen to go away. */
async function backUp(oldPid, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const s = await api.status();
      if (s.pid !== oldPid) return true;
    } catch {
      /* still down */
    }
  }
  return false;
}

/**
 * Waits for a server running `commit` to answer, or for the update log to say the install
 * failed - in which case the old server is still up and the log says why.
 * @returns {Promise<'updated'|'failed'|'timeout'>}
 */
async function updatedTo(commit, oldPid, ms = 5 * 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const s = await api.status();
      if (s.pid !== oldPid && (!commit || s.commit === commit)) return 'updated';
      if (s.pid === oldPid) {
        const u = await api.updateStatus();
        if (u.last && !u.last.running && u.last.exit !== 0) return 'failed';
      }
    } catch {
      /* restarting */
    }
  }
  return 'timeout';
}

const short = (c) => (c ? c.slice(0, 7) : 'unknown');

/** Settings → Server → Update: reinstall Bench from the checkout it was installed from. */
function Update({ server, busy }) {
  const [st, setSt] = useState(null);
  const [phase, setPhase] = useState(null);
  const load = () => api.updateStatus().then(setSt).catch(() => {});
  useEffect(() => {
    load();
  }, []);
  if (!st) return null;

  const run = async () => {
    const what = st.newer ? `${st.newer} newer commit${st.newer === 1 ? '' : 's'}` : 'the checkout as it is';
    const ok = await confirmAction({
      title: 'Update Bench?',
      body:
        `Installs ${what} from ${st.source} (${short(st.sourceCommit)}) and restarts the server. ` +
        (st.sourceDirty ? 'The checkout has uncommitted changes, and they are installed too. ' : '') +
        (busy ? `${busy} session${busy === 1 ? ' is' : 's are'} mid-turn and will be stopped; they resume on the next message.` : 'Open sessions resume on their next message.'),
      confirmLabel: 'Update',
      tone: busy || st.sourceDirty ? 'danger' : 'default',
    });
    if (!ok) return;
    setPhase('updating');
    try {
      await api.startUpdate();
    } catch (e) {
      setPhase(null);
      return toast(e);
    }
    const r = await updatedTo(st.sourceCommit, server.pid);
    if (r === 'updated') {
      showToast(`Updated to ${short(st.sourceCommit)}. Reloading…`, 'success');
      // The page itself is part of the update: its files come from the new release.
      setTimeout(() => location.reload(), 800);
      return;
    }
    setPhase(null);
    load();
    showToast(r === 'failed' ? 'The update failed; the log is below.' : 'The server has not come back on the new version. Check the log below and the service logs.', 'error');
  };

  const failed = st.last && !st.last.running && st.last.exit !== 0;
  return html`
    <${Row}
      label="Update"
      hint=${st.installed
        ? html`Installed <code>${short(st.installed.commit)}</code>${st.installed.dirty ? ' with uncommitted changes' : ''}, <${Time} at=${st.installed.installedAt} />. Checkout <code>${st.source}</code> is at <code>${short(st.sourceCommit)}</code>${st.newer === 0 ? ', the same commit' : st.newer ? html`, <strong class="set-strong">${st.newer} newer commit${st.newer === 1 ? '' : 's'}</strong>` : ''}.`
        : st.reason && !st.last?.running
          ? st.reason
          : null}
      after=${html`
        ${st.installed && st.reason && !st.last?.running ? html`<p class="set-note">${st.reason}</p>` : null}
        ${st.sourceDirty ? html`<div class="notice notice-warn">The checkout has uncommitted changes. An update installs the files as they are, changes included.</div>` : null}
        ${failed && !phase
          ? html`<details class="notice notice-bad"><summary>The last update failed (exit ${st.last.exit}), <${Time} at=${st.last.at} /></summary><pre class="check-output">${st.last.tail}</pre></details>`
          : null}
      `}
    >
      <button class="btn sm secondary" type="button" disabled=${!st.canUpdate || !!phase} onClick=${run}>
        ${phase ? 'Updating… the server will restart' : st.newer === 0 && !st.sourceDirty ? 'Reinstall Bench' : 'Update Bench'}
      </button>
    <//>
  `;
}

function Server() {
  const [server, setServer] = useState(null);
  const [failed, setFailed] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const busy = useStore((s) => s.sessions.filter((x) => x.status === 'running' || x.status === 'waiting').length);
  const load = () =>
    api.status().then(
      (r) => {
        setServer(r);
        setFailed(false);
      },
      () => setFailed(true)
    );
  useEffect(() => {
    load();
  }, []);

  const restart = async () => {
    const ok = await confirmAction({
      title: 'Restart the server?',
      body: busy
        ? `${busy} session${busy === 1 ? ' is' : 's are'} mid-turn and will be stopped. Their conversations resume on the next message.`
        : 'It is back in a few seconds. Open sessions resume on their next message.',
      confirmLabel: 'Restart',
      tone: busy ? 'danger' : 'default',
    });
    if (!ok) return;
    setRestarting(true);
    try {
      await api.restart();
    } catch (e) {
      setRestarting(false);
      return toast(e);
    }
    const back = await backUp(server.pid);
    setRestarting(false);
    if (back) {
      showToast('Server restarted', 'success');
      load();
      reconnectNow();
    } else showToast('The server has not come back. Check the service logs on the machine.', 'error');
  };

  return html`
    <${Group} id="server" title="Server" hint=${server ? html`<span class="mono-sm">bench ${server.version} · up ${formatDuration(server.uptimeMs)} · pid ${server.pid} · data in ${server.root}</span>` : null}>
      ${!server
        ? failed
          ? html`<${LoadFailed} what="the server's status" retry=${load} />`
          : html`<${SkeletonRows} n=${2} />`
        : server.supervised
          ? html`<${Row} label="Restart server" hint=${`Running as a ${server.supervised} service, which starts it again whenever it stops. Sessions mid-turn are stopped and resume on their next message.`}>
                <button class="btn sm secondary" type="button" disabled=${restarting} onClick=${restart}>${restarting ? 'Restarting…' : 'Restart server'}</button>
              <//>
              <${Update} server=${server} busy=${busy} />`
          : html`<div class="notice notice-warn">Not running as a service: if it stops, nothing starts it again, and it cannot be restarted from here. On the server, run <code>bench service install</code>.</div>`}
    <//>
  `;
}
