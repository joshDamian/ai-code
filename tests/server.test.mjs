import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

// The server as a process: auth, pairing, the event socket and static files.

let child;
let port;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aic-server-'));

before(async () => {
  child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PORT: '0', AI_CODE_ROOT: root, AI_CODE_PUBLIC_URL: 'https://box.example.ts.net' },
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
  assert.equal(state.json.me.device.name, 'Phone');
});

test('writes must be JSON', async () => {
  const r = await req('POST', '/api/projects', { host: REMOTE, cookie, body: 'path=/tmp', type: 'application/x-www-form-urlencoded' });
  assert.equal(r.status, 415);
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

test('a restart is refused when no service manager would bring the server back', async () => {
  const status = await req('GET', '/api/server/status');
  assert.equal(status.json.supervised, null);
  const r = await req('POST', '/api/server/restart', { body: {} });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /service install/);
  assert.equal((await req('GET', '/api/server/status')).status, 200, 'still up');
});

test('under a service manager, a restart exits so the manager starts a fresh process', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aic-svc-'));
  const proc = spawn(process.execPath, ['src/server.mjs'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PORT: '0', AI_CODE_ROOT: dir, AI_CODE_SERVICE: 'test' },
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
