// Browser notifications with sound for completed runs.
//
// Permission is requested once on the first attempt. The sound is a short
// synthesised tone rather than a file, so there is nothing to host or load.

let permissionState = typeof Notification !== 'undefined' ? Notification.permission : 'denied';

export function requestPermission() {
  if (typeof Notification === 'undefined') return Promise.resolve('denied');
  if (permissionState === 'granted') return Promise.resolve('granted');
  return Notification.requestPermission().then((p) => {
    permissionState = p;
    return p;
  });
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

export function notify(title, body, { onClick } = {}) {
  playSound();
  if (permissionState !== 'granted') return;
  try {
    const n = new Notification(title, { body, icon: '/favicon.ico', tag: title });
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
