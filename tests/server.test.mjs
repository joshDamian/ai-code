import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { tmp } from './tmp.mjs';

// The server as a process: auth, pairing, the event socket and static files.

let child;
let port;
const root = tmp('server');

before(async () => {
  child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: new URL('..', import.meta.url).pathname,
    // BENCH_SERVICE is set when these tests run inside a Bench session; this server is
    // the one without a service manager, so it must not inherit it.
    env: { ...process.env, PORT: '0', BENCH_ROOT: root, BENCH_PUBLIC_URL: 'https://box.example.ts.net', BENCH_SERVICE: '', AI_CODE_SERVICE: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  port = await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      const m = /localhost:(\d+)/.exec(out);
      if (m) resolve(Number(m[1]));
    });
    child.on('exit', (c) => reject(new Error(`server exited ${c}`)));
  });
});

after(() => child?.kill());

/** A request with whatever Host the test claims, which fetch cannot set. */
function req(method, p, { host = `localhost:${port}`, body, cookie, origin, type = 'application/json' } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { host, ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}), ...(body !== undefined ? { 'content-type': type } : {}) };
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let text = '';
      res.on('data', (d) => (text += d));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode, headers: res.headers, json, text });
      });
    });
    r.on('error', reject);
    if (body !== undefined) r.write(typeof body === 'string' ? body : JSON.stringify(body));
    r.end();
  });
}

const REMOTE = 'box.example.ts.net';
let cookie;

test('this machine needs no token; anyone else does', async () => {
  const local = await req('GET', '/api/state');
  assert.equal(local.status, 200);
  assert.equal(local.json.me.local, true);
  assert.equal(local.json.providers.length, 4);
  assert.equal((await req('GET', '/api/state', { host: REMOTE })).status, 401);
  // A proxy in front of loopback is not this machine.
  const proxied = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: '/api/state', headers: { host: `localhost:${port}`, 'x-forwarded-for': '100.64.0.2' } }, (res) => resolve(res.statusCode));
  });
  assert.equal(proxied, 401);
  // A page on another origin cannot ride the loopback exemption.
  assert.equal((await req('GET', '/api/state', { origin: 'https://evil.example' })).status, 401);
});

test('a pairing code becomes a device cookie, once', async () => {
  const p = await req('POST', '/api/pairing', { body: {} });
  assert.equal(p.status, 200);
  assert.equal(p.json.urls[0], `https://box.example.ts.net/#/pair/${p.json.code}`);
  assert.match(p.json.qr, /<svg/);
  const paired = await req('POST', '/api/pair', { host: REMOTE, body: { code: p.json.code, name: 'Phone' } });
  assert.equal(paired.status, 200);
  const set = paired.headers['set-cookie'][0];
  assert.match(set, /HttpOnly; SameSite=Strict/);
  assert.match(set, /Secure/, 'a tailnet host is HTTPS');
  cookie = set.split(';')[0];
  assert.equal((await req('POST', '/api/pair', { host: REMOTE, body: { code: p.json.code, name: 'Again' } })).status, 401);
  const state = await req('GET', '/api/state', { host: REMOTE, cookie });
  assert.equal(state.status, 200);
  assert.match(cookie, /^bench=/);
  // A device paired before the rename carries the old cookie name.
  assert.equal((await req('GET', '/api/state', { host: REMOTE, cookie: cookie.replace(/^bench=/, 'aic=') })).status, 200);
  assert.equal(state.json.me.device.name, 'Phone');
});

test('a device can change what it is notified about, and only for an endpoint it registered', async () => {
  const sub = { endpoint: 'https://push.example/one', keys: { p256dh: 'p', auth: 'a' }, choices: { approvals: true, finished: true, errors: true } };
  assert.equal((await req('POST', '/api/push/subscribe', { host: REMOTE, cookie, body: sub })).json.ok, true);
  const changed = await req('POST', '/api/push/choices', { host: REMOTE, cookie, body: { endpoint: sub.endpoint, choices: { approvals: true, finished: false, errors: true } } });
  assert.equal(changed.json.ok, true);
  // Nothing to update is not a success: the endpoint is unknown to this server.
  assert.equal((await req('POST', '/api/push/choices', { host: REMOTE, cookie, body: { endpoint: 'https://push.example/none', choices: {} } })).json.ok, false);
});

test('writes must be JSON', async () => {  const r = await req('POST', '/api/projects', { host: REMOTE, cookie, body: 'path=/tmp', type: 'application/x-www-form-urlencoded' });
  assert.equal(r.status, 415);
});

test('a file upload must be raw bytes, and comes from a paired device', async () => {
  const json = await req('POST', '/api/sessions/nope/uploads?name=a.apk', { host: REMOTE, cookie, body: '{}' });
  assert.equal(json.status, 415);
  const form = await req('POST', '/api/sessions/nope/uploads?name=a.apk', { host: REMOTE, cookie, body: 'x', type: 'text/plain' });
  assert.equal(form.status, 415);
  const stranger = await req('POST', '/api/sessions/nope/uploads?name=a.apk', { host: REMOTE, body: 'x', type: 'application/octet-stream' });
  assert.equal(stranger.status, 401);
  const missing = await req('POST', '/api/sessions/nope/uploads?name=a.apk', { host: REMOTE, cookie, body: 'x', type: 'application/octet-stream' });
  assert.equal(missing.status, 404);
});

test('the event socket checks origin and auth, then says hello', async () => {
  const open = (headers) =>
    new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, { headers });
      ws.on('message', (m) => {
        resolve(JSON.parse(String(m)));
        ws.close();
      });
      ws.on('error', (e) => resolve({ error: e.message }));
      ws.on('unexpected-response', (_, res) => resolve({ status: res.statusCode }));
    });
  assert.deepEqual(await open({ host: REMOTE }), { status: 401 });
  assert.deepEqual(await open({ host: REMOTE, cookie, origin: 'https://evil.example' }), { status: 403 });
  const hello = await open({ host: REMOTE, cookie, origin: `https://${REMOTE}` });
  assert.equal(hello.type, 'hello');
  assert.deepEqual(hello.sessions, []);
});

test('a revoked device is shut out', async () => {
  const devices = await req('GET', '/api/devices');
  const phone = devices.json.find((d) => d.name === 'Phone');
  await req('DELETE', `/api/devices/${phone.id}`);
  assert.equal((await req('GET', '/api/state', { host: REMOTE, cookie })).status, 401);
});

test('static files and vendored libraries are served, and nothing outside them', async () => {
  const index = await req('GET', '/');
  assert.equal(index.status, 200);
  assert.match(index.text, /<script type="importmap">/);
  const preact = await req('GET', '/vendor/preact/dist/preact.module.js');
  assert.equal(preact.status, 200);
  assert.match(preact.headers['content-type'], /javascript/);
  assert.equal((await req('GET', '/vendor/preact/../../package.json')).status, 404);
  assert.equal((await req('GET', '/vendor/nope/x.js')).status, 404);
  assert.equal((await req('GET', '/..%2f..%2fpackage.json')).status, 404);
  // A client route falls back to the app.
  assert.equal((await req('GET', '/p/abc')).status, 200);
});

// A session's files: served from under its directory and nowhere else, opened only as a
// type the browser can show safely, and then only in a sandbox.
test('a session file opens inline in a sandbox, or downloads, and nothing outside its directory', async () => {
  const dir = tmp('files');
  fs.writeFileSync(path.join(dir, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]));
  fs.writeFileSync(path.join(dir, 'page.html'), '<script>alert(1)</script>');
  fs.writeFileSync(path.join(dir, 'kron.apk'), 'PK');
  fs.mkdirSync(path.join(dir, 'out'));
  fs.symlinkSync('/etc/passwd', path.join(dir, 'leak.txt'));
  const project = await req('POST', '/api/projects', { body: { path: dir, init: true } });
  assert.equal(project.status, 200, project.text);
  const session = await req('POST', '/api/sessions', { body: { projectId: project.json.id } });
  assert.equal(session.status, 200, session.text);
  const url = (p, dl = '') => `/api/sessions/${session.json.id}/files?path=${encodeURIComponent(p)}${dl}`;

  const png = await req('GET', url('shot.png'));
  assert.equal(png.status, 200);
  assert.equal(png.headers['content-type'], 'image/png');
  assert.equal(png.headers['content-length'], '8');
  assert.equal(png.headers['content-security-policy'], 'sandbox');
  assert.equal(png.headers['x-content-type-options'], 'nosniff');
  assert.equal(png.headers['content-disposition'], undefined);
  // An absolute path inside the directory is the same file.
  assert.equal((await req('GET', url(path.join(dir, 'shot.png')))).status, 200);

  const html = await req('GET', url('page.html'));
  assert.match(html.headers['content-type'], /text\/html/);
  assert.equal(html.headers['content-security-policy'], 'sandbox');

  const dl = await req('GET', url('shot.png', '&download=1'));
  assert.equal(dl.headers['content-disposition'], `attachment; filename="shot.png"; filename*=UTF-8''shot.png`);
  assert.equal(dl.headers['x-content-type-options'], 'nosniff');
  // A type that is never opened downloads even when opening is asked for.
  const apk = await req('GET', url('kron.apk'));
  assert.equal(apk.headers['content-type'], 'application/vnd.android.package-archive');
  assert.match(apk.headers['content-disposition'], /^attachment; filename="kron.apk"/);

  const ranged = await new Promise((resolve) =>
    http.get({ host: '127.0.0.1', port, path: url('shot.png'), headers: { host: `localhost:${port}`, range: 'bytes=2-5' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    })
  );
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers['content-range'], 'bytes 2-5/8');
  assert.deepEqual([...ranged.body], [0x4e, 0x47, 1, 2]);

  for (const p of ['../../etc/passwd', '/etc/passwd', 'leak.txt', 'out', 'missing.png', '']) assert.equal((await req('GET', url(p))).status, 404, p);
  assert.equal((await req('GET', `/api/sessions/nope/files?path=shot.png`)).status, 404);
  assert.equal((await req('GET', url('shot.png'), { host: REMOTE })).status, 401);
  // A paired phone's <img> and <a href> carry its cookie and nothing else, and that is enough.
  const code = (await req('POST', '/api/pairing', { body: {} })).json.code;
  const phone = (await req('POST', '/api/pair', { host: REMOTE, body: { code, name: 'Phone 2' } })).headers['set-cookie'][0].split(';')[0];
  const fromPhone = await req('GET', url('shot.png'), { host: REMOTE, cookie: phone });
  assert.equal(fromPhone.status, 200);
  assert.equal(fromPhone.headers['content-type'], 'image/png');

  // The project's own files are tracked, so they are its source; one made afterwards is an artifact.
  fs.writeFileSync(path.join(dir, 'out', 'kron-release.apk'), 'PK');
  const stat = await req('POST', `/api/sessions/${session.json.id}/files/stat`, { body: { paths: ['shot.png', 'out/kron-release.apk', 'out', '../../etc/passwd', 'leak.txt', 'nope.txt'] } });
  assert.deepEqual(stat.json, {
    'shot.png': { path: path.join(dir, 'shot.png'), name: 'shot.png', mime: 'image/png', size: 8, open: true, kind: 'image', artifact: false },
    'out/kron-release.apk': { path: path.join(dir, 'out', 'kron-release.apk'), name: 'kron-release.apk', mime: 'application/vnd.android.package-archive', size: 2, open: false, kind: 'archive', artifact: true },
  });
});

test('a restart is refused when no service manager would bring the server back', async () => {
  const status = await req('GET', '/api/server/status');
  assert.equal(status.json.supervised, null);
  const r = await req('POST', '/api/server/restart', { body: {} });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /service install/);
  assert.equal((await req('GET', '/api/server/status')).status, 200, 'still up');
});

test('under a service manager, a restart exits so the manager starts a fresh process', async () => {
  const dir = tmp('svc');
  const proc = spawn(process.execPath, ['src/server.mjs'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PORT: '0', BENCH_ROOT: dir, BENCH_SERVICE: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const p = await new Promise((resolve) => {
    let out = '';
    proc.stdout.on('data', (d) => {
      out += d;
      const m = /localhost:(\d+)/.exec(out);
      if (m) resolve(Number(m[1]));
    });
  });
  const exited = new Promise((resolve) => proc.on('exit', (code) => resolve(code)));
  const res = await fetch(`http://127.0.0.1:${p}/api/server/restart`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 200);
  assert.equal(await exited, 0);
});
