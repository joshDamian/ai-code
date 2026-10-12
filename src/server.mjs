// @ts-check
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { WebSocketServer } from 'ws';
import QRCode from 'qrcode';
import { Service } from './service.mjs';
import { TerminalSessions } from './terminal.mjs';
import { providerEnv } from './providers.mjs';
import { env, loadEnvFile } from './env.mjs';
import { MODES, MAX_UPLOAD } from './runtime.mjs';

/** @typedef {import('./contract.mjs').ServerMessage} ServerMessage */

// The HTTP and WebSocket front of the service. Everything a client can do is a JSON
// route over the Service; everything that changes is pushed down /api/ws.
//
// Who may call: a request from this machine's own browser (Host and Origin both
// loopback) needs nothing. Anything else needs a paired device's token, sent as the
// `aic` cookie the pairing set or as a Bearer header. `tailscale serve` proxies to
// loopback but keeps the tailnet hostname in Host, so a phone always presents a token.

const root = env('ROOT') || process.cwd();
// Provider keys kept in the data folder's env file: read before anything looks for them.
loadEnvFile(root);
const port = Number(process.env.PORT ?? 4317);
const host = env('HOST') || '127.0.0.1';
const loopbackBind = /^(localhost|127\.\d+\.\d+\.\d+|::1)$/.test(host);
if (!loopbackBind && !env('ALLOW_EXPOSED')) {
  console.error(
    `BENCH_HOST=${host} exposes the server beyond this machine. Prefer \`bench share\` (tailscale serve).\n` +
      'Set BENCH_ALLOW_EXPOSED=1 to bind it anyway; every request will still need a paired device.'
  );
  process.exit(1);
}

// BENCH_FAKE_SDK=1 runs sessions on the scripted fake the tests use, for working on
// the interface without spending anything.
const fake = env('FAKE_SDK') === '1' ? (await import('../tests/fake-sdk.mjs')).fakeQuery : undefined;
const svc = new Service(root, fake ? { query: /** @type {any} */ (fake) } : {});
const terminals = new TerminalSessions({ reapMs: Number(env('TERMINAL_REAP_MS')) || undefined });
const startedAt = Date.now();
const webDir = new URL('../web/', import.meta.url).pathname;
const modulesDir = new URL('../node_modules/', import.meta.url).pathname;
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// -- auth -------------------------------------------------------------------------------

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/** @param {http.IncomingMessage} req */
function fromLocalhost(req) {
  if (!LOCAL_HOST.test(req.headers.host || '')) return false;
  // A proxy in front of this server is not this machine's browser, whatever Host says.
  if (req.headers['x-forwarded-for'] || req.headers['tailscale-user-login']) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return LOCAL_HOST.test(new URL(origin).host);
  } catch {
    return false;
  }
}

/** @param {http.IncomingMessage} req */
function presentedToken(req) {
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  if (bearer) return bearer[1].trim();
  // `aic` is the cookie's name from before the rename; a device paired then stays paired.
  const cookie = /(?:^|;\s*)(?:bench|aic)=([^;]+)/.exec(req.headers.cookie || '');
  return cookie ? decodeURIComponent(cookie[1]) : '';
}

// An install-wide token from the environment still works, for scripts.
const envToken = env('TOKEN') || null;

/** @param {http.IncomingMessage} req @returns {{local:boolean, device:{id:string,name:string}|null}|null} */
function who(req) {
  if (fromLocalhost(req)) return { local: true, device: null };
  const t = presentedToken(req);
  if (!t) return null;
  if (envToken && t.length === envToken.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(envToken))) return { local: false, device: { id: 'env', name: 'BENCH_TOKEN' } };
  const d = svc.store.deviceByToken(t);
  return d ? { local: false, device: d } : null;
}

// A WebSocket is not covered by CORS, so a page elsewhere could open one with the
// person's cookie attached. The Origin has to be this server.
/** @param {http.IncomingMessage} req */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

// Failed pairing attempts, by address, so a code cannot be guessed at speed.
const pairFailures = new Map();

// -- push -------------------------------------------------------------------------------

/** @type {any} */
let webpush = null;
/** @type {{publicKey:string, privateKey:string}|null} */
let vapid = null;
try {
  webpush = (await import('web-push')).default;
  const stored = { publicKey: svc.store.getSetting('vapid_public') || '', privateKey: svc.store.getSetting('vapid_private') || '' };
  const keys = stored.publicKey && stored.privateKey ? stored : webpush.generateVAPIDKeys();
  if (keys !== stored) {
    svc.store.setSetting('vapid_public', keys.publicKey);
    svc.store.setSetting('vapid_private', keys.privateKey);
  }
  webpush.setVapidDetails('mailto:noreply@localhost', keys.publicKey, keys.privateKey);
  vapid = keys;
} catch {
  /* no push on this install */
}

/** @param {{title:string, body:string, url?:string, tag?:string}} payload */
async function pushAll(payload) {
  if (!vapid) return;
  await Promise.allSettled(
    svc.store.listPushSubscriptions().map(async (/** @type {any} */ s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload));
      } catch (e) {
        const code = /** @type {any} */ (e)?.statusCode;
        if (code === 404 || code === 410) svc.store.deletePushSubscription(s.endpoint);
      }
    })
  );
}

/** @param {import('./contract.mjs').Session} s */
const sessionUrl = (s) => (s.task_id ? `/#/p/${s.project_id}/t/${s.task_id}/s/${s.id}` : `/#/p/${s.project_id}/s/${s.id}`);

// -- the event hub ----------------------------------------------------------------------

/** @type {Set<import('ws').WebSocket & {watch?: Set<string>, alive?: boolean}>} */
const clients = new Set();

/** @param {ServerMessage} msg @param {string} [sessionId] only to clients watching it */
function broadcast(msg, sessionId) {
  const text = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState !== 1) continue;
    if (sessionId && !ws.watch?.has(sessionId)) continue;
    // A client that has stopped reading (a phone asleep, a dead link) would have every
    // message queued for it in memory. Past a point it is dropped; it reconnects and
    // reloads what it missed.
    if (ws.bufferedAmount > 4 * 1024 * 1024) {
      ws.terminate();
      continue;
    }
    ws.send(text);
  }
}

// Streaming text arrives a few characters at a time. Sent as is, that is dozens of
// frames a second per session, each one a re-render on the phone at the other end of a
// slow link. Deltas are gathered for a moment and sent as one; anything else about the
// session first flushes what is gathered, so the order the client sees is unchanged.
const DELTA_MS = 60;
/** @type {Map<string, {text:string, thinking:boolean, timer:ReturnType<typeof setTimeout>}>} */
const deltas = new Map();
/** @param {string} sessionId */
function flushDelta(sessionId) {
  const d = deltas.get(sessionId);
  if (!d) return;
  deltas.delete(sessionId);
  clearTimeout(d.timer);
  broadcast({ type: 'delta', session_id: sessionId, text: d.text, ...(d.thinking ? { thinking: true } : {}) }, sessionId);
}
/** @param {{session_id:string, text:string, thinking?:boolean}} d */
function queueDelta(d) {
  const thinking = !!d.thinking;
  const cur = deltas.get(d.session_id);
  if (cur && cur.thinking !== thinking) flushDelta(d.session_id);
  const next = deltas.get(d.session_id);
  if (next) next.text += d.text;
  else deltas.set(d.session_id, { text: d.text, thinking, timer: setTimeout(() => flushDelta(d.session_id), DELTA_MS) });
}

svc.runtime.on('session', (s) => {
  flushDelta(s.id);
  broadcast({ type: 'session', session: s });
});
svc.runtime.on('session-removed', (id) => {
  flushDelta(id);
  broadcast({ type: 'session-removed', id });
});
svc.runtime.on('event', (e) => {
  flushDelta(e.session_id);
  broadcast({ type: 'event', event: e }, e.session_id);
});
svc.runtime.on('delta', queueDelta);
svc.runtime.on('approval', (a) => {
  broadcast({ type: 'approval', approval: a });
  const s = svc.store.getSession(a.session_id);
  if (s) pushAll({ title: `Approval needed: ${a.tool}`, body: `${s.title}${a.title ? ` — ${a.title}` : ''}`, url: sessionUrl(s), tag: `approval-${a.id}` }).catch(() => {});
});
svc.runtime.on('approval-done', (a) => broadcast({ type: 'approval-done', ...a }));
svc.runtime.on('turn-done', ({ session, ok }) => {
  if (session) pushAll({ title: ok ? 'Claude finished' : 'Claude stopped with an error', body: session.title, url: sessionUrl(session), tag: `turn-${session.id}` }).catch(() => {});
});
svc.on('task', (t) => broadcast({ type: 'task', task: t }));
svc.on('git', (projectId) => broadcast({ type: 'git', project_id: projectId }));

// -- helpers ----------------------------------------------------------------------------

/** @param {http.ServerResponse} res @param {unknown} body @param {number} [status] */
function json(res, body, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body ?? null));
}

// Room for 60 MB of attachments, base64-encoded (a third bigger), and the message.
const MAX_BODY = 85 * 1024 * 1024;

/** @param {http.IncomingMessage} req @returns {Promise<any>} */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    /** @type {Buffer[]} */
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Request too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

// The browser libraries, served from node_modules so a page loads with no CDN. Only
// these directories are reachable.
const VENDOR = {
  preact: 'preact',
  htm: 'htm/dist',
  marked: 'marked/lib',
  dompurify: 'dompurify/dist',
  xterm: '@xterm/xterm',
  'xterm-fit': '@xterm/addon-fit/lib',
  hljs: '@highlightjs/cdn-assets',
  mermaid: 'mermaid/dist',
};

/** @param {http.ServerResponse} res @param {string} file @param {boolean} [immutable] */
function sendFile(res, file, immutable = false) {
  const type = TYPES[/** @type {keyof typeof TYPES} */ (path.extname(file))] || 'application/octet-stream';
  res.writeHead(200, { 'content-type': type, 'cache-control': immutable ? 'public, max-age=604800' : 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

/** @param {string} base @param {string} rel */
function within(base, rel) {
  const full = path.resolve(base, rel);
  return full === base || full.startsWith(base.endsWith(path.sep) ? base : base + path.sep) ? full : null;
}

/** @param {http.IncomingMessage} req @param {http.ServerResponse} res @param {URL} u */
function serveStatic(req, res, u) {
  if (u.pathname.startsWith('/vendor/')) {
    const [, , name, ...rest] = u.pathname.split('/');
    const dir = VENDOR[/** @type {keyof typeof VENDOR} */ (name)];
    const file = dir && within(path.join(modulesDir, dir), decodeURIComponent(rest.join('/')));
    if (file && fs.existsSync(file) && fs.statSync(file).isFile()) return sendFile(res, file, true);
    res.writeHead(404).end();
    return;
  }
  const rel = u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname.slice(1));
  const file = within(webDir, rel);
  if (file && fs.existsSync(file) && fs.statSync(file).isFile()) return sendFile(res, file);
  // An unknown path without an extension is a client route.
  if (!path.extname(rel)) return sendFile(res, path.join(webDir, 'index.html'));
  res.writeHead(404).end();
}

// -- session files ------------------------------------------------------------------------
//
// What a session built - an APK, a screenshot, a PDF - fetched from the transcript. A file
// is served only from under the session's directory or its attachments folder, and only
// by type: what the browser can show opens, everything else downloads.

// The types a file may be opened as. Anything not here is served as a download, whatever
// is asked for, so the browser never gets to guess at a session's bytes.
const OPENABLE = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
};

// Only named so a download says what it is. None of these is ever sent inline.
const DOWNLOAD_ONLY = {
  '.apk': 'application/vnd.android.package-archive',
  '.aab': 'application/octet-stream',
  '.ipa': 'application/octet-stream',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tgz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.7z': 'application/x-7z-compressed',
  '.jar': 'application/java-archive',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

// What a file is, for how the transcript presents it. Unknown extensions are 'other'.
/** @type {Record<string, string>} */
const KINDS = {
  image: '.png .jpg .jpeg .gif .webp .avif .bmp .ico .svg',
  pdf: '.pdf',
  text: '.txt .log .md .csv .json .xml .html .htm',
  archive: '.apk .aab .ipa .zip .gz .tgz .tar .7z .jar .wasm',
  media: '.mp4 .webm .mp3 .wav',
  document: '.docx .xlsx',
};
/** @param {string} file */
const fileKind = (file) => {
  const ext = path.extname(file).toLowerCase();
  return Object.keys(KINDS).find((k) => ext && KINDS[k].split(' ').includes(ext)) || 'other';
};

/**
 * Which of a session's files git tracks: those are its source, which Claude names all
 * the time, not something it made to hand over. Null when the directory is not a
 * repository, so the caller falls back to the kind of file.
 * @param {string} cwd @param {string[]} files absolute
 * @returns {Promise<Set<string>|null>}
 */
function trackedFiles(cwd, files) {
  if (!files.length) return Promise.resolve(new Set());
  return new Promise((resolve) =>
    execFile('git', ['-C', cwd, 'ls-files', '-z', '--full-name', '--', ...files.map((f) => path.relative(cwd, f))], { maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
      if (err) return resolve(null);
      execFile('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], (e2, top) => {
        if (e2) return resolve(null);
        resolve(new Set(String(out).split('\0').filter(Boolean).map((f) => path.join(String(top).trim(), f))));
      });
    })
  );
}

/** @param {string} file */
function fileType(file) {
  const ext = /** @type {keyof typeof OPENABLE} */ (path.extname(file).toLowerCase());
  const open = OPENABLE[ext];
  return { mime: open || DOWNLOAD_ONLY[/** @type {keyof typeof DOWNLOAD_ONLY} */ (ext)] || 'application/octet-stream', open: !!open };
}

/** @param {string} p */
const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
};

/**
 * The regular file a session may hand out at `p`, relative to its directory or absolute,
 * or null. within() catches `..` and absolute paths elsewhere; the real path is checked
 * too, because a symlink the session made inside its directory can point anywhere.
 * @param {string} sessionId @param {string} p
 */
function sessionFile(sessionId, p) {
  const s = svc.store.getSession(sessionId);
  if (!s || !p) return null;
  for (const base of [s.cwd, svc.runtime.attachmentsDir(s.id)]) {
    const full = within(base, p);
    const realBase = full && real(base);
    const realFull = realBase && real(full);
    if (!realBase || !realFull || !within(realBase, path.relative(realBase, realFull))) continue;
    const st = fs.statSync(realFull, { throwIfNoEntry: false });
    if (st?.isFile()) return { full, real: realFull, size: st.size, ...fileType(full) };
  }
  return null;
}

/** A Range header's one span, clamped to the file; null for none, false for one that cannot be met. @param {string|undefined} h @param {number} size */
function byteRange(h, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(h || '');
  if (!m || (!m[1] && !m[2])) return null;
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  return start <= end && start < size ? { start, end } : false;
}

// An inline response is same-origin with the dashboard. CSP sandbox gives it an opaque
// origin with no scripts, so an HTML or SVG file the session wrote cannot act with the
// person's cookie. A download is never rendered and needs none of that.
/** @param {http.IncomingMessage} req @param {http.ServerResponse} res @param {string} sessionId @param {URL} u */
function sendSessionFile(req, res, sessionId, u) {
  const f = sessionFile(sessionId, u.searchParams.get('path') || '');
  if (!f) return json(res, { error: 'Not found' }, 404);
  const inline = f.open && u.searchParams.get('download') !== '1';
  /** @type {Record<string, string|number>} */
  const headers = { 'content-type': f.mime, 'x-content-type-options': 'nosniff', 'cache-control': 'private, no-cache', 'accept-ranges': 'bytes' };
  if (inline) headers['content-security-policy'] = 'sandbox';
  else {
    const name = path.basename(f.full);
    headers['content-disposition'] = `attachment; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`;
  }
  const range = byteRange(req.headers.range, f.size);
  if (range === false) {
    res.writeHead(416, { ...headers, 'content-range': `bytes */${f.size}` }).end();
    return;
  }
  const span = range || { start: 0, end: f.size - 1 };
  if (range) headers['content-range'] = `bytes ${span.start}-${span.end}/${f.size}`;
  headers['content-length'] = f.size ? span.end - span.start + 1 : 0;
  res.writeHead(range ? 206 : 200, headers);
  if (req.method === 'HEAD' || !f.size) return res.end();
  const stream = fs.createReadStream(f.real, { start: span.start, end: span.end });
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

/** The addresses a phone could reach this server at. */
async function publicUrls() {
  const urls = [];
  const configured = env('PUBLIC_URL');
  if (configured) urls.push(configured.replace(/\/$/, ''));
  const ts = await new Promise((resolve) => execFile('tailscale', ['status', '--json'], { timeout: 5000 }, (err, out) => resolve(err ? null : out)));
  if (ts) {
    try {
      const name = JSON.parse(String(ts))?.Self?.DNSName?.replace(/\.$/, '');
      if (name) urls.push(`https://${name}`);
    } catch {
      /* not running */
    }
  }
  return [...new Set(urls)];
}

// -- routes -----------------------------------------------------------------------------

/** @typedef {{req:http.IncomingMessage, res:http.ServerResponse, u:URL, params:string[], body:any, auth:{local:boolean, device:{id:string,name:string}|null}}} Ctx */
/** @type {[string, RegExp, (c: Ctx) => any][]} */
const routes = [];
/** @param {string} method @param {string} pattern @param {(c: Ctx) => any} fn */
const route = (method, pattern, fn) => routes.push([method, new RegExp(`^${pattern.replace(/:[a-z]+/g, '([^/]+)')}$`), fn]);

route('GET', '/api/state', ({ auth }) => ({
  version: pkg.version,
  projects: svc.store.listProjects(),
  tasks: svc.tasks(),
  sessions: svc.sessions(),
  approvals: svc.runtime.pending(),
  providers: svc.providers(),
  defaults: svc.defaults(),
  me: { local: auth.local, device: auth.device },
  push: vapid ? vapid.publicKey : null,
}));

route('GET', '/api/projects', () => svc.store.listProjects());
route('POST', '/api/projects/clone', ({ body }) => svc.cloneProject(body));
route('POST', '/api/projects/create', ({ body }) => svc.createProject(body));
route('GET', '/api/github/repos', () => svc.githubRepos());
route('POST', '/api/projects', ({ body }) => svc.addProject(body));
route('PATCH', '/api/projects/:id', ({ params, body }) => svc.store.updateProject(params[0], body));
route('DELETE', '/api/projects/:id', ({ params }) => (svc.removeProject(params[0]), { ok: true }));
route('GET', '/api/projects/:id/git', ({ params }) => svc.git(params[0]));
route('GET', '/api/projects/:id/diff', ({ params }) => svc.checkoutDiff(params[0]));
route('POST', '/api/projects/:id/fetch', ({ params }) => svc.fetch(params[0]));
route('POST', '/api/projects/:id/pull', ({ params }) => svc.pull(params[0]));
route('POST', '/api/projects/:id/push', ({ params }) => svc.push(params[0]));
route('POST', '/api/projects/:id/checkout', ({ params, body }) => svc.checkout(params[0], body));
route('POST', '/api/projects/:id/commit', ({ params, body }) => svc.commit(params[0], body.message));

// A directory browser for adding a project from a phone. Names only, never contents.
route('GET', '/api/fs', ({ u }) => {
  // A folder that does not exist yet (the default projects folder before its first
  // project) opens at the nearest parent that does.
  let dir = path.resolve(u.searchParams.get('path') || os.homedir());
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => ({ name: e.name, repo: fs.existsSync(path.join(dir, e.name, '.git')) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { path: dir, parent: path.dirname(dir) === dir ? null : path.dirname(dir), repo: fs.existsSync(path.join(dir, '.git')), entries };
});

// A new folder, for choosing where a project goes. One level, inside a folder that exists.
route('POST', '/api/fs/mkdir', ({ body }) => {
  const parent = path.resolve(String(body.parent || ''));
  const name = String(body.name || '').trim();
  if (!name || name.includes('/') || name.startsWith('.') || !fs.existsSync(parent)) throw new Error('Choose a folder name');
  const dir = path.join(parent, name);
  fs.mkdirSync(dir);
  return { path: dir };
});

route('GET', '/api/tasks', ({ u }) => svc.tasks(u.searchParams.get('projectId') || undefined));
route('POST', '/api/tasks', ({ body }) => svc.createTask(body.projectId, body));
route('GET', '/api/tasks/:id', ({ params }) => ({ task: svc.task(params[0]), git: svc.taskGit(params[0]), sessions: svc.sessions({ taskId: params[0], archived: true }) }));
route('PATCH', '/api/tasks/:id', ({ params, body }) => svc.renameTask(params[0], body));
route('GET', '/api/tasks/:id/git', ({ params }) => svc.taskGit(params[0]));
route('GET', '/api/tasks/:id/diff', ({ params }) => svc.taskDiff(params[0]));
route('POST', '/api/tasks/:id/commit', ({ params, body }) => svc.commitTask(params[0], body.message));
route('POST', '/api/tasks/:id/update', ({ params }) => svc.updateFromBase(params[0]));
route('POST', '/api/tasks/:id/abort-merge', ({ params }) => svc.abortTaskMerge(params[0]));
route('POST', '/api/tasks/:id/merge', ({ params, body }) => svc.mergeTask(params[0], body));
route('POST', '/api/tasks/:id/push', ({ params }) => svc.pushTask(params[0]));
route('POST', '/api/tasks/:id/pr', ({ params, body }) => svc.pullRequest(params[0], body));
route('POST', '/api/tasks/:id/close', ({ params, body }) => svc.closeTask(params[0], body));
route('POST', '/api/tasks/:id/reopen', ({ params }) => svc.reopenTask(params[0]));

route('GET', '/api/sessions', ({ u }) =>
  svc.sessions({ projectId: u.searchParams.get('projectId') || undefined, taskId: u.searchParams.get('taskId') || undefined, archived: u.searchParams.get('archived') === '1' })
);
route('POST', '/api/sessions', ({ body }) => svc.createSession(body));
route('GET', '/api/sessions/:id', ({ params }) => ({
  session: svc.session(params[0]),
  events: svc.events(params[0]),
  approvals: svc.runtime.pending(params[0]),
  live: svc.runtime.isLive(params[0]),
  commands: svc.runtime.commands(params[0]),
}));
route('GET', '/api/sessions/:id/events', ({ params, u }) => svc.events(params[0], { before: Number(u.searchParams.get('before')) || undefined, limit: Number(u.searchParams.get('limit')) || undefined }));
route('POST', '/api/sessions/:id/messages', ({ params, body }) => svc.send(params[0], body.text, { images: body.images, files: body.files, uploads: body.uploads }));
route('GET', '/api/sessions/:id/files', ({ req, res, params, u }) => sendSessionFile(req, res, params[0], u));
// Which of the paths a transcript mentions are files, and what each is. The client
// cannot stat and must not guess a type from a name, so it asks here, for all of a
// transcript's paths at once. Anything missing, a directory, or out of reach is left out.
//
// `artifact` is whether the transcript should offer the file at all: something the
// session made or was given - an attachment, a build output, anything git does not
// track - rather than the source it is working on. Without a repository to ask, an
// image, PDF, archive or document is one and text is not.
route('POST', '/api/sessions/:id/files/stat', async ({ params, body }) => {
  const s = svc.session(params[0]);
  /** @type {string[]} */
  const paths = Array.isArray(body.paths) ? body.paths.slice(0, 500).map(String) : [];
  const attachments = svc.runtime.attachmentsDir(s.id) + path.sep;
  /** @type {[string, NonNullable<ReturnType<typeof sessionFile>>][]} */
  const found = [];
  for (const p of paths) {
    const f = sessionFile(s.id, p);
    if (f) found.push([p, f]);
  }
  const tracked = await trackedFiles(s.cwd, [...new Set(found.map(([, f]) => f.full))].filter((f) => !f.startsWith(attachments)));
  /** @type {Record<string, {path:string, name:string, mime:string, size:number, open:boolean, kind:string, artifact:boolean}>} */
  const files = {};
  for (const [p, f] of found) {
    const kind = fileKind(f.full);
    const artifact = f.full.startsWith(attachments) || (tracked ? !tracked.has(f.full) : !['text', 'other'].includes(kind));
    files[p] = { path: f.full, name: path.basename(f.full), mime: f.mime, size: f.size, open: f.open, kind, artifact };
  }
  return files;
});
route('POST', '/api/sessions/:id/interrupt', async ({ params }) => ({ ok: await svc.interrupt(params[0]) }));
route('PATCH', '/api/sessions/:id', ({ params, body }) => svc.updateSession(params[0], body));
route('POST', '/api/sessions/:id/archive', ({ params, body }) => svc.archiveSession(params[0], body.archived !== false));
route('DELETE', '/api/sessions/:id', ({ params }) => svc.deleteSession(params[0]));
route('POST', '/api/approvals/:id', ({ params, body }) => ({ ok: svc.runtime.answer(params[0], body) }));

route('GET', '/api/providers', () => svc.providers());
route('PATCH', '/api/providers/:id', ({ params, body }) => svc.updateProvider(params[0], body));
route('POST', '/api/providers/:id/test', ({ params, body }) => svc.testProvider(params[0], body.modelId));
route('PATCH', '/api/models/:id', ({ params, body }) => svc.updateModel(decodeURIComponent(params[0]), body));
route('GET', '/api/defaults', () => svc.defaults());
route('PUT', '/api/defaults', ({ body }) => svc.setDefaults(body));
route('GET', '/api/usage', () => svc.usage());
route('GET', '/api/doctor', () => svc.doctor());

route('GET', '/api/devices', () => svc.store.listDevices());
route('DELETE', '/api/devices/:id', ({ params }) => ({ ok: svc.store.revokeDevice(params[0]) }));
// A one-time code a new device trades for its own token. Ten minutes, single use.
route('POST', '/api/pairing', async () => {
  const code = crypto.randomBytes(9).toString('base64url');
  svc.store.addPairing(code, 10 * 60 * 1000);
  const urls = (await publicUrls()).map((base) => `${base}/#/pair/${code}`);
  const qr = urls[0] ? await QRCode.toString(urls[0], { type: 'svg', margin: 1 }) : null;
  return { code, urls, qr, expiresIn: 600 };
});

route('GET', '/api/push/key', () => (vapid ? { key: vapid.publicKey } : Promise.reject(Object.assign(new Error('Push is not available'), { status: 503 }))));
route('POST', '/api/push/subscribe', ({ body }) => (svc.store.addPushSubscription(body), { ok: true }));
route('POST', '/api/push/unsubscribe', ({ body }) => ({ ok: svc.store.deletePushSubscription(body.endpoint) > 0 }));

// Whether something will start this process again after it exits: the service
// definition `bench service install` writes says so.
const supervised = env('SERVICE') || null;

route('GET', '/api/server/status', () => ({ pid: process.pid, startedAt, uptimeMs: Date.now() - startedAt, version: pkg.version, root, terminals: terminals.size, supervised }));
// Exits so the service manager starts a fresh process. Refused when nothing would, since
// a restart that is really a stop leaves a phone with no way back.
route('POST', '/api/server/restart', () => {
  if (!supervised) throw Object.assign(new Error('Not running as a service, so nothing would start it again. Run `bench service install` on the server.'), { status: 409 });
  setTimeout(shutdown, 100);
  return { ok: true };
});
route('POST', '/api/server/shutdown', ({ auth }) => {
  if (!auth.local) throw Object.assign(new Error('Only from this machine'), { status: 403 });
  setTimeout(shutdown, 50);
  return { ok: true };
});

/** @param {http.IncomingMessage} req @param {http.ServerResponse} res @param {URL} u */
async function pair(req, res, u) {
  const addr = req.socket.remoteAddress || '?';
  const f = pairFailures.get(addr) || { n: 0, at: 0 };
  if (f.n >= 10 && Date.now() - f.at < 15 * 60 * 1000) return json(res, { error: 'Too many attempts; try again later' }, 429);
  const body = await readBody(req);
  if (!svc.store.usePairing(String(body.code || ''))) {
    pairFailures.set(addr, { n: f.n + 1, at: Date.now() });
    return json(res, { error: 'That pairing code is wrong or has expired' }, 401);
  }
  pairFailures.delete(addr);
  const token = crypto.randomBytes(32).toString('base64url');
  const device = svc.store.addDevice(String(body.name || 'Device').slice(0, 60), token);
  const secure = u.protocol === 'https:' || req.headers['x-forwarded-proto'] === 'https' || /\.ts\.net(:\d+)?$/.test(req.headers.host || '');
  res.setHeader('set-cookie', `bench=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${secure ? '; Secure' : ''}`);
  json(res, { device });
}

/** @param {http.IncomingMessage} req @param {http.ServerResponse} res @param {URL} u @param {string} sessionId */
async function receiveUpload(req, res, u, sessionId) {
  if (!/^application\/octet-stream/.test(req.headers['content-type'] || '')) return json(res, { error: 'Send the file as application/octet-stream' }, 415);
  const declared = Number(req.headers['content-length']);
  if (declared > MAX_UPLOAD) {
    json(res, { error: `Files over ${MAX_UPLOAD / 1024 / 1024} MB cannot be attached` }, 413);
    return req.destroy();
  }
  try {
    svc.session(sessionId);
    const out = await svc.runtime.receiveFile(sessionId, u.searchParams.get('name') || 'file', u.searchParams.get('type') || '', req);
    json(res, out);
  } catch (e) {
    const err = /** @type {any} */ (e);
    if (!res.headersSent) json(res, { error: err.message }, err.status || 400);
    req.destroy();
  }
}

/** @param {http.IncomingMessage} req @param {http.ServerResponse} res */
async function handle(req, res) {
  const u = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (!u.pathname.startsWith('/api/')) return serveStatic(req, res, u);
  if (u.pathname === '/api/pair' && req.method === 'POST') return pair(req, res, u);
  if (u.pathname === '/api/ping') return json(res, { ok: true, paired: !!who(req) });
  const auth = who(req);
  if (!auth) return json(res, { error: 'unauthorized' }, 401);
  // A file upload is the raw bytes. application/octet-stream, like JSON, cannot be sent
  // cross-site without a preflight, which this server never answers.
  const upload = req.method === 'POST' && /^\/api\/sessions\/([^/]+)\/uploads$/.exec(u.pathname);
  if (upload) return receiveUpload(req, res, u, decodeURIComponent(upload[1]));
  // A write must be JSON, which a cross-site form cannot send without a preflight.
  if (req.method !== 'GET' && req.method !== 'DELETE' && !/^application\/json/.test(req.headers['content-type'] || '')) return json(res, { error: 'Send JSON' }, 415);
  for (const [method, re, fn] of routes) {
    if (method !== req.method) continue;
    const m = re.exec(u.pathname);
    if (!m) continue;
    try {
      const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req);
      const out = await fn({ req, res, u, params: m.slice(1).map(decodeURIComponent), body, auth });
      if (!res.headersSent) json(res, out);
    } catch (e) {
      const err = /** @type {any} */ (e);
      if (!res.headersSent) json(res, { error: err.message, code: err.code, conflicts: err.conflicts, dirty: err.dirty }, err.status || 400);
    }
    return;
  }
  json(res, { error: 'Not found' }, 404);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (!res.headersSent) json(res, { error: e.message }, 500);
  });
});

// -- WebSockets: the event hub and the terminals -----------------------------------------

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

// A connection that died without a close (a phone that lost signal, a NAT that forgot
// it) still looks open here. Each is pinged; one that has not answered by the next
// round is closed, so it stops collecting messages and the client knows to reconnect.
const heartbeat = setInterval(() => {
  for (const ws of clients) {
    if (!ws.alive) {
      ws.terminate();
      clients.delete(ws);
      continue;
    }
    ws.alive = false;
    try {
      ws.ping();
    } catch {
      /* closed meanwhile */
    }
  }
}, 30000);
heartbeat.unref();

/** @param {import('node:stream').Duplex} socket @param {string} status */
const refuse = (socket, status) => {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
};

server.on('upgrade', (req, socket, head) => {
  let u;
  try {
    u = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  } catch {
    return socket.destroy();
  }
  if (!sameOrigin(req)) return refuse(socket, '403 Forbidden');
  if (!who(req)) return refuse(socket, '401 Unauthorized');

  if (u.pathname === '/api/ws') {
    return wss.handleUpgrade(req, socket, head, (ws) => {
      const client = /** @type {import('ws').WebSocket & {watch?: Set<string>, alive?: boolean}} */ (ws);
      client.watch = new Set();
      client.alive = true;
      clients.add(client);
      client.on('pong', () => (client.alive = true));
      client.on('close', () => clients.delete(client));
      client.on('error', () => {});
      client.on('message', (raw) => {
        try {
          const msg = JSON.parse(String(raw));
          if (msg.type === 'watch' && Array.isArray(msg.ids)) client.watch = new Set(msg.ids.slice(0, 50).map(String));
          else if (msg.type === 'ping') {
            client.alive = true;
            client.send(JSON.stringify({ type: 'pong' }));
          }
        } catch {
          /* ignored */
        }
      });
      client.send(JSON.stringify({ type: 'hello', sessions: svc.sessions(), approvals: svc.runtime.pending() }));
    });
  }

  if (u.pathname === '/api/terminal') {
    if (env('DISABLE_TERMINAL')) return refuse(socket, '403 Forbidden');
    const spec = terminalSpec(u);
    if ('error' in spec) return refuse(socket, spec.error);
    return wss.handleUpgrade(req, socket, head, (ws) => {
      let t;
      try {
        t = terminals.open(spec);
      } catch (e) {
        return ws.close(1011, String(/** @type {Error} */ (e).message).slice(0, 120));
      }
      terminals.attach(t, ws);
    });
  }
  socket.destroy();
});

/**
 * Which shell a terminal socket opens: in a task's worktree, in a project's checkout, or
 * a `claude --resume` on a session's own conversation - the escape hatch to the real TUI.
 * @param {URL} u
 * @returns {{error:string} | {key:string, cwd:string, command?:string, env?:Record<string,string>}}
 */
function terminalSpec(u) {
  const q = u.searchParams;
  try {
    if (q.get('session')) {
      const s = svc.session(/** @type {string} */ (q.get('session')));
      // Both values go into a shell line, so both are checked to be what they claim.
      if (!s.claude_session_id || !/^[0-9a-f-]{8,64}$/i.test(s.claude_session_id) || !MODES.includes(/** @type {any} */ (s.permission_mode))) return { error: '409 Conflict' };
      if (svc.runtime.isLive(s.id)) {
        if (s.status === 'running' || s.status === 'waiting') return { error: '409 Conflict' };
        svc.runtime.close(s.id);
      }
      const provider = svc.store.getProvider(s.provider_id);
      const model = s.model_id ? svc.store.getModel(s.model_id) || null : null;
      const env = provider ? providerEnv(provider, model) : {};
      return { key: `session:${s.id}`, cwd: s.cwd, command: `exec claude --resume ${s.claude_session_id} --permission-mode ${s.permission_mode}`, env };
    }
    if (q.get('task')) {
      const t = svc.task(/** @type {string} */ (q.get('task')));
      if (!fs.existsSync(t.worktree)) return { error: '409 Conflict' };
      return { key: `task:${t.id}`, cwd: t.worktree };
    }
    if (q.get('project')) {
      const p = svc.project(/** @type {string} */ (q.get('project')));
      return { key: `project:${p.id}`, cwd: p.path };
    }
  } catch {
    return { error: '404 Not Found' };
  }
  return { error: '400 Bad Request' };
}

// -- lifecycle ----------------------------------------------------------------------------

let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  svc.shutdown();
  terminals.killAll();
  for (const ws of clients) ws.close(1001, 'server shutting down');
  server.close();
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(port, host, () => {
  const a = server.address();
  const bound = a && typeof a === 'object' ? a.port : port;
  console.log(`Bench: http://localhost:${bound}`);
  if (loopbackBind) console.log('Other devices: run `bench share`, then pair from Settings or `bench pair`.');
});
