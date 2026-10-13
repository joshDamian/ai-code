// @ts-check
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

/** @typedef {import('./contract.mjs').Session} Session */
/** @typedef {import('./contract.mjs').Project} Project */
/** @typedef {import('./contract.mjs').Task} Task */
/** One line of `ps`, as read. @typedef {{pid:number, ppid:number, rssKb:number, pcpu:number, etime:string, etimeMs:number|null, command:string}} Proc */

// What Bench is costing the machine: memory, disk and the processes it is holding.
//
// The one number that matters - how much memory Bench's own processes hold - is read
// from the service's cgroup, because it is the machine's own answer and covers every
// process together, including the pages they share. Where there is no cgroup (macOS,
// or a Linux without cgroup v2) the same figure is summed from the process tree instead
// and the difference is reported rather than hidden, so the page never shows a number
// it cannot stand behind.
//
// The parsers are pure and exported: `ps` output and cgroup files are what actually
// vary between machines, and they are the part worth pinning in a test without one.

// A process list is small (a few hundred lines) but a runaway fork could make it large.
const MAX_BUFFER = 8 * 1024 * 1024;
const PS_TIMEOUT = 4000;
const DU_TIMEOUT = 8000;

/** Runs a command and resolves its stdout, never rejecting: a machine that cannot
 * answer is a fact about the machine, not an error in the caller.
 * @param {string} cmd @param {string[]} args @param {number} timeout */
function run(cmd, args, timeout) {
  return new Promise((resolve) => {
    /** @type {import('node:child_process').ChildProcess|undefined} */
    let child;
    try {
      child = execFile(cmd, args, { timeout, maxBuffer: MAX_BUFFER, encoding: 'utf8' }, (err, stdout) => {
        resolve({ stdout: stdout || '', pid: child?.pid, ok: !err });
      });
    } catch {
      resolve({ stdout: '', pid: undefined, ok: false });
    }
  });
}

// `ps` prints elapsed as `[[dd-]hh:]mm:ss` - `03:15` is three minutes fifteen, `1:02:03`
// an hour and change, `2-03:15:40` two days on top of that. Which fields are present is
// the whole parse: reading `03:15` as hours and minutes is the mistake this avoids.
/** @param {string} s @returns {number|null} milliseconds, or null if it is not a time */
export function parseEtime(s) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(s || '').trim());
  if (!m) return null;
  const [, d, h, mi, se] = m;
  return (((Number(d || 0) * 24 + Number(h || 0)) * 60 + Number(mi)) * 60 + Number(se)) * 1000;
}

// One line per process, from `ps -Ao pid=,ppid=,rss=,pcpu=,etime=,command=`. The `=`
// suffix drops the header row, so every line is data. The command is the rest of the
// line and is allowed to contain anything, including nothing at all (a kernel thread).
/**
 * @param {string} stdout
 * @returns {Proc[]}
 */
export function parsePs(stdout) {
  const out = [];
  for (const line of String(stdout || '').split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s*(.*)$/.exec(line);
    if (!m) continue;
    out.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      rssKb: Number(m[3]),
      pcpu: Number(m[4]),
      etime: m[5],
      etimeMs: parseEtime(m[5]),
      command: m[6] || '',
    });
  }
  return out;
}

// `/proc/self/cgroup` under cgroup v2 is a single `0::<path>` line. Under v1 it is a
// list of controllers, and the path it names is a v1 hierarchy this does not understand,
// so anything that is not the v2 form is reported as no cgroup rather than misread.
/** @param {string} text @returns {string|null} */
export function parseCgroupPath(text) {
  const m = /^0::(\S+)$/m.exec(String(text || ''));
  return m ? m[1] : null;
}

const CGROUP_ROOT = '/sys/fs/cgroup';

/** The cgroup directory this process is in, resolved once and re-resolved after a
 * failure (a restart under a different unit moves it). @returns {string|null} */
let cachedCgroup = /** @type {string|null|undefined} */ (undefined);
export function cgroupDir() {
  if (cachedCgroup !== undefined) return cachedCgroup;
  cachedCgroup = null;
  try {
    const rel = parseCgroupPath(fs.readFileSync('/proc/self/cgroup', 'utf8'));
    if (rel) {
      const dir = rel === '/' ? CGROUP_ROOT : path.join(CGROUP_ROOT, rel);
      if (fs.existsSync(path.join(dir, 'memory.current'))) cachedCgroup = dir;
    }
  } catch {
    cachedCgroup = null;
  }
  return cachedCgroup;
}

/** @param {string} dir @param {string} file @returns {string|null} */
function readCgroupFile(dir, file) {
  try {
    return fs.readFileSync(path.join(dir, file), 'utf8').trim();
  } catch {
    return null;
  }
}

/**
 * The service's own memory and process count, as the kernel accounts for them.
 * `max` means no limit was set. @param {string} dir
 * @returns {{memCurrent:number, memPeak:number|null, memMax:number|null, pids:number|null}|null}
 */
export function readCgroup(dir) {
  const cur = readCgroupFile(dir, 'memory.current');
  if (cur == null) return null;
  const num = (/** @type {string|null} */ v) => (v == null || v === 'max' ? null : Number(v));
  const pids = readCgroupFile(dir, 'pids.current');
  return {
    memCurrent: Number(cur),
    memPeak: num(readCgroupFile(dir, 'memory.peak')),
    memMax: num(readCgroupFile(dir, 'memory.max')),
    pids: pids == null ? null : Number(pids),
  };
}

/** The machine, which is what Bench's share is measured against. @param {string} diskPath */
export function machineInfo(diskPath) {
  /** @type {{total:number|null, free:number|null}} */
  let disk = { total: null, free: null };
  try {
    const s = fs.statfsSync(diskPath);
    disk = { total: s.bsize * s.blocks, free: s.bsize * s.bavail };
  } catch {
    // A path this cannot stat is a path with no disk to report, not a failed dashboard.
  }
  return {
    hostname: os.hostname(),
    platform: process.platform,
    cpus: os.cpus().length,
    loadavg: os.loadavg(),
    uptimeMs: os.uptime() * 1000,
    memTotal: os.totalmem(),
    memFree: os.freemem(),
    diskPath,
    diskTotal: disk.total,
    diskFree: disk.free,
  };
}

// -- attribution --------------------------------------------------------------------------
//
// Which of the machine's processes are Bench's, and which conversation is holding each.
// The tree is walked from the server's own pid, and a process with no attribution of its
// own inherits its parent's: a `git` a session ran belongs to that session, and a `vim`
// in a terminal belongs to that terminal. Nothing is guessed into a session it did not
// come from - anything the walk cannot place lands in one "other" row that is named.

/** @param {{key:string, pid:number|null, cwd:string}[]} terminals */
function terminalOwners(terminals) {
  /** @type {Map<number, {key:string}>} */
  const byPid = new Map();
  for (const t of terminals) if (t.pid) byPid.set(t.pid, { key: t.key });
  return byPid;
}

// A terminal's key names what it was opened for: `session:<id>`, `task:<id>` or
// `project:<id>`. This reads that back into the ids the page links with.
/** @param {string} key @param {{sessions:Session[], projects:Project[], tasks:Task[]}} o */
function terminalWhere(key, o) {
  const [kind, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
  if (kind === 'session') {
    const s = o.sessions.find((x) => x.id === id);
    return { sessionId: id, taskId: s?.task_id ?? null, projectId: s?.project_id ?? null, label: s?.title || 'Session shell' };
  }
  if (kind === 'task') {
    const t = o.tasks.find((x) => x.id === id);
    return { sessionId: null, taskId: id, projectId: t?.project_id ?? null, label: t ? `${t.title} — shell` : 'Task shell' };
  }
  if (kind === 'project') {
    const p = o.projects.find((x) => x.id === id);
    return { sessionId: null, taskId: null, projectId: id, label: p ? `${p.name} — shell` : 'Project shell' };
  }
  return { sessionId: null, taskId: null, projectId: null, label: 'Shell' };
}

/**
 * The processes Bench is holding, rolled up one row per thing that owns them.
 * @param {Proc[]} procs
 * @param {{rootPid:number, claudePids:Map<number,string>, terminals:{key:string,pid:number|null,cwd:string}[], sessions:Session[], projects:Project[], tasks:Task[]}} o
 * @returns {import('./contract.mjs').MetricProcess[]}
 */
export function rows(procs, o) {
  const byParent = new Map();
  for (const p of procs) {
    if (!byParent.has(p.ppid)) byParent.set(p.ppid, []);
    byParent.get(p.ppid).push(p);
  }
  const termByPid = terminalOwners(o.terminals);

  /** @typedef {{kind:'claude'|'terminal'|'server'|'other', sessionId:string|null, taskId:string|null, projectId:string|null, label:string, sub:string, pool:Proc[]}} Group */
  /** @type {Map<string, Group>} */
  const groups = new Map();
  /** @param {string} key @param {() => Omit<Group, 'pool'>} make @returns {Group} */
  const groupOf = (key, make) => {
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { ...make(), pool: [] }));
    return g;
  };
  /** @param {string} id */
  const projectName = (id) => o.projects.find((p) => p.id === id)?.name || '';

  // Depth-first, carrying the owner down. A child is only re-owned by something the
  // walk recognises as its own parent process, never by a pid seen elsewhere.
  /** @param {number} pid @param {string|null} ownerKey */
  const walk = (pid, ownerKey) => {
    for (const child of byParent.get(pid) || []) {
      let key = ownerKey;
      if (child.pid !== o.rootPid) {
        const sid = o.claudePids.get(child.pid);
        const term = termByPid.get(child.pid);
        if (sid) {
          const s = o.sessions.find((x) => x.id === sid);
          key = `session:${sid}`;
          groupOf(key, () => ({
            kind: 'claude',
            sessionId: sid,
            taskId: s?.task_id ?? null,
            projectId: s?.project_id ?? null,
            label: s?.title || 'Session',
            sub: projectName(s?.project_id || ''),
          }));
        } else if (term) {
          const w = terminalWhere(term.key, o);
          key = `term:${term.key}`;
          groupOf(key, () => ({ kind: 'terminal', ...w, sub: projectName(w.projectId || '') }));
        } else if (!ownerKey) {
          key = 'other';
        }
      }
      const g = key ? groupOf(key, () => ({ kind: 'other', sessionId: null, taskId: null, projectId: null, label: 'Other Bench processes', sub: '' })) : null;
      if (g) g.pool.push(child);
      walk(child.pid, key);
    }
  };
  walk(o.rootPid, null);

  // The server's own process is the root of the walk and never a child of it, so it is
  // added by pid. Without it the row a person most expects - "bench server" - is absent.
  const self = procs.find((p) => p.pid === o.rootPid);
  if (self) groupOf('server', () => ({ kind: 'server', sessionId: null, taskId: null, projectId: null, label: 'bench server', sub: '' })).pool.push(self);

  /** @param {Proc[]} pool @param {(p: Proc) => number} f */
  const sum = (pool, f) => pool.reduce((a, p) => a + f(p), 0);
  return [...groups.values()]
    .map((g) => ({
      kind: g.kind,
      sessionId: g.sessionId,
      taskId: g.taskId,
      projectId: g.projectId,
      label: g.label,
      sub: g.sub,
      count: g.pool.length,
      pid: g.pool[0]?.pid ?? null,
      rssKb: sum(g.pool, (p) => p.rssKb),
      pcpu: Math.round(sum(g.pool, (p) => p.pcpu) * 10) / 10,
      etimeMs: g.pool.reduce((a, p) => (p.etimeMs != null && p.etimeMs > a ? p.etimeMs : a), 0) || null,
    }))
    .sort((a, b) => b.rssKb - a.rssKb);
}

// -- storage ------------------------------------------------------------------------------
//
// `du` walks a tree and can take seconds on a large checkout, so its answer is cached and
// refreshed off the request path: a dashboard that waits on du is a dashboard that hangs
// on the one machine where it matters. The machine's own total and free come from statfs,
// which costs nothing and so is never cached.

const DU_TTL = 60 * 1000;
/** @type {Map<string, {bytes:number|null, at:number, running:boolean}>} */
const duCache = new Map();

/** @param {string} dir @returns {Promise<number|null>} bytes, or null while unknown */
function du(dir) {
  const hit = duCache.get(dir);
  const fresh = hit && Date.now() - hit.at < DU_TTL;
  if (fresh) return Promise.resolve(hit.bytes);
  if (hit?.running) return Promise.resolve(hit.bytes);
  const prev = hit?.bytes ?? null;
  duCache.set(dir, { bytes: prev, at: hit?.at ?? 0, running: true });
  return run('du', ['-sk', dir], DU_TIMEOUT).then((r) => {
    const kb = Number(/\d+/.exec(r.stdout)?.[0]);
    const bytes = r.ok && Number.isFinite(kb) ? kb * 1024 : prev;
    duCache.set(dir, { bytes, at: Date.now(), running: false });
    return bytes;
  });
}

/**
 * The size of each directory Bench owns, plus the machine's own disk. A directory that
 * cannot be measured reports null rather than zero, so the page can say it does not know.
 * @param {{name:string, path:string, note?:string}[]} targets
 * @param {{diskPath:string, diskTotal:number|null, diskFree:number|null}} machine
 */
export async function storage(targets, machine) {
  // One at a time: `du` is disk-bound, and a dozen of them at once on the small machine
  // this exists to watch is the load it is being asked to report. Cached per directory,
  // so the second poll onward is a map lookup.
  /** @type {(number|null)[]} */
  const sizes = [];
  for (const t of targets) sizes.push(await du(t.path));
  const entries = targets.map((t, i) => ({ name: t.name, path: t.path, note: t.note || '', bytes: sizes[i] }));
  return {
    entries: entries.filter((e) => e.bytes != null || fs.existsSync(e.path)),
    diskPath: machine.diskPath,
    diskTotal: machine.diskTotal,
    diskFree: machine.diskFree,
  };
}

// -- the snapshot -------------------------------------------------------------------------

/**
 * Everything the Dashboard draws, in one call. The slow part - du over the project
 * checkouts - is cached inside `storage`, so a poll that lands inside the window answers
 * from memory and never touches the disk.
 * @param {{
 *   root: string,
 *   sessions: Session[], projects: Project[], tasks: Task[],
 *   claudePids: Map<number,string>,
 *   terminals: {key:string, pid:number|null, cwd:string}[],
 *   storageTargets: {name:string, path:string, note?:string}[],
 *   cgroupDir?: string|null,
 *   psOutput?: string,
 * }} o
 */
export async function collect(o) {
  const machine = machineInfo(o.root);
  // `psOutput` is what the tests give instead of a real process table; the machine's own
  // `ps` is the only other source, and a machine that cannot run it reports no rows.
  const { stdout, pid } = o.psOutput !== undefined ? { stdout: o.psOutput, pid: undefined } : await run('ps', ['-Ao', 'pid=,ppid=,rss=,pcpu=,etime=,command='], PS_TIMEOUT);
  const cg = o.cgroupDir === undefined ? cgroupDir() : o.cgroupDir;
  // The `ps` this just ran is a child of the server and would show up as one of Bench's
  // own processes. It is not, so it is dropped by the pid the spawn handed back.
  const procs = parsePs(stdout).filter((p) => p.pid !== pid);
  const processRows = rows(procs, { ...o, rootPid: process.pid });
  const accounted = processRows.filter((r) => r.kind !== 'other');

  const fromCgroup = cg ? readCgroup(cg) : null;
  const rssBytes = processRows.reduce((a, r) => a + r.rssKb * 1024, 0);
  const bench = fromCgroup
    ? { ...fromCgroup, source: 'cgroup' }
    : { memCurrent: rssBytes, memPeak: null, memMax: null, pids: accounted.reduce((a, r) => a + r.count, 0), source: 'rss' };

  return {
    at: Date.now(),
    host: machine,
    machine: {
      memTotal: machine.memTotal,
      memFree: machine.memFree,
      diskTotal: machine.diskTotal,
      diskFree: machine.diskFree,
      diskPath: machine.diskPath,
    },
    bench: { ...bench, procs: accounted.reduce((a, r) => a + r.count, 0) },
    procs: processRows,
    storage: await storage(o.storageTargets, machine),
  };
}
