// Browser notifications with sound for completed runs.
//
// Permission is requested once on the first attempt. The sound is a short
// synthesised tone rather than a file, so there is nothing to host or load.
//
// A granted permission and a push subscription are two different things and both are
// wanted here. The first makes the in-page notification work while a tab is open; the
// second is what makes one arrive when no tab is - which, on a phone, is the entire
// point, since a backgrounded PWA is not running this code at all.

import { api } from '../api.mjs';

let permissionState = typeof Notification !== 'undefined' ? Notification.permission : 'denied';

export function requestPermission() {
  if (typeof Notification === 'undefined') return Promise.resolve('denied');
  if (permissionState === 'granted') {
    subscribeToPush();
    return Promise.resolve('granted');
  }
  return Notification.requestPermission().then((p) => {
    permissionState = p;
    if (p === 'granted') subscribeToPush();
    return p;
  });
}

// Registers this browser for background push, once per page load. Silent on every
// failure: push needs a secure context, a service worker, a granted permission and a
// server that has `web-push` installed, and none of those being absent is a reason to
// break the in-page notifier that has always worked without them.
let pushAttempted = false;

async function subscribeToPush() {
  if (pushAttempted) return;
  if (typeof navigator === 'undefined' || !navigator.serviceWorker || !('PushManager' in window)) return;
  pushAttempted = true;
  try {
    // `ready` rather than `register(...)`: the registration is started by index.html,
    // and this waits for whichever one that produced instead of racing it.
    const reg = await navigator.serviceWorker.ready;
    const { key } = await api.pushKey();
    // An existing subscription is reused as-is. It is re-sent to the server anyway,
    // because the server's copy is keyed on this endpoint and a database that was
    // reset would otherwise never learn about a browser that is already subscribed.
    const sub =
      (await reg.pushManager.getSubscription()) ||
      (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) }));
    await api.pushSubscribe(sub.toJSON());
  } catch {
    // No push on this browser, or the server has none to offer. The in-page notifier
    // is unaffected, and the next page load gets another attempt.
    pushAttempted = false;
  }
}

// The server's VAPID key travels as base64url; `applicationServerKey` takes the bytes.
function urlBase64ToUint8Array(base64) {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function playSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.setValueAtTime(1047, ctx.currentTime + 0.08);
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.3);
  } catch {
    // No audio context available; skip silently.
  }
}

// `tag` collapses notifications about the same thing - a push and this one for the
// same permission prompt show once, not twice.
export function notify(title, body, { onClick, tag = title } = {}) {
  playSound();
  if (permissionState !== 'granted') return;
  try {
    const n = new Notification(title, { body, icon: '/icons/icon-192.png', tag });
    if (onClick) n.onclick = () => { window.focus(); onClick(); n.close(); };
  } catch {
    // Notification blocked or unavailable.
  }
}

// Tracks which runs have already been notified so a poll loop does not fire
// twice for the same completion.
const notified = new Set();

const ROLE_LABEL = {
  planner: 'Planning',
  implementer: 'Implementation',
  reviewer: 'Review',
  repair: 'Repair',
  'context-enrich': 'Context enrichment',
  chat: 'Chat',
};

export function notifyRunEnd(run, task, navigate) {
  if (!run || !run.id) return;
  if (notified.has(run.id)) return;
  notified.add(run.id);
  // Keep the set from growing without bound across a long session.
  if (notified.size > 500) {
    const first = notified.values().next().value;
    notified.delete(first);
  }

  const succeeded = run.status === 'succeeded';
  const role = ROLE_LABEL[run.role] || run.role || 'Run';
  const taskTitle = task?.title ? `: ${task.title}` : '';
  const title = `${role} ${succeeded ? 'completed' : 'failed'}`;
  const body = `${role}${taskTitle} — ${succeeded ? 'succeeded' : run.error || 'failed'}`;

  notify(title, body, {
    onClick: task?.id && navigate ? () => navigate(`#/tasks/${task.id}`) : undefined,
  });
}
