#!/usr/bin/env node
// @ts-check
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { env } from './env.mjs';

// The command line. Most of the tool lives in the browser; this starts the server,
// registers projects, pairs devices and installs the service.

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');
const port = Number(process.env.PORT || 4317);
const dataRoot = env('ROOT') || process.cwd();

const HELP = `bench - a workbench for Claude sessions

  bench serve                 run the server in the foreground (default)
  bench open                  open the app in a browser
  bench add <path> [name]     register a repository as a project (--init to git init it)
  bench projects              list projects
  bench share [--port <n>]    publish the server on your tailnet (tailscale serve)
                              --force takes over a port another service holds, --off undoes it
  bench pair                  print a one-time link (and QR code) that pairs a device
  bench devices               list paired devices
  bench revoke <device-id>    unpair a device
  bench service install       run the server at login and keep it running
  bench service uninstall     remove that service
  bench service status        whether the service is installed and running
  bench doctor                check git, node, claude, gh and the providers
  bench shell <provider> [..] an interactive \`claude\` billed to that provider

Environment: PORT (default 4317), BENCH_ROOT (where the database lives),
BENCH_PUBLIC_URL (the address other devices reach this server at).`;

/** @param {unknown} x */
const out = (x) => console.log(typeof x === 'string' ? x : JSON.stringify(x, null, 2));

/** A call to the running server, over loopback, which needs no token. @param {string} method @param {string} p @param {unknown} [body] */
async function api(method, p, body) {
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error(`No server on port ${port}. Start it with \`bench serve\` or \`bench service install\`.`);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `Server answered ${res.status}`);
  return data;
}

async function service() {
  const { Service } = await import('./service.mjs');
  return new Service(dataRoot);
}

// -- the OS service -------------------------------------------------------------------------

const LABEL = 'com.bench.server';
// What earlier versions installed, which held the same port.
const OLD_LABELS = ['com.ai-code.supervisor', 'com.ai-code.server'];
const OLD_UNIT = path.join(os.homedir(), '.config', 'systemd', 'user', 'ai-code.service');
const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const unit = path.join(os.homedir(), '.config', 'systemd', 'user', 'bench.service');

/** @param {string} s */
const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

function serviceInstall() {
  const node = process.execPath;
  const server = path.join(appRoot, 'src', 'server.mjs');
  // The PATH of this shell goes with it: the service starts `claude`, `git` and `gh`, and
  // a service manager gives a job almost no PATH of its own.
  /** @type {Record<string, string>} */
  // BENCH_SERVICE tells the server a service manager will restart it, which is what
  // makes the Restart button in Settings safe to offer.
  const vars = { BENCH_ROOT: dataRoot, PORT: String(port), PATH: process.env.PATH || '/usr/bin:/bin', BENCH_SERVICE: process.platform === 'darwin' ? 'launchd' : 'systemd' };
  for (const k of ['DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY', 'FIREWORKS_API_KEY']) if (process.env[k]) vars[k] = String(process.env[k]);
  const publicUrl = env('PUBLIC_URL');
  if (publicUrl) vars.BENCH_PUBLIC_URL = publicUrl;
  if (process.platform === 'darwin') {
    const logs = path.join(os.homedir(), 'Library', 'Logs', 'bench');
    fs.mkdirSync(logs, { recursive: true });
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    const domain = `gui/${process.getuid?.()}`;
    for (const label of OLD_LABELS) {
      const old = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
      if (!fs.existsSync(old)) continue;
      spawnSync('launchctl', ['bootout', `${domain}/${label}`]);
      fs.rmSync(old);
      console.log(`Removed the earlier service (${label}).`);
    }
    // Owner-only: it can carry provider API keys.
    fs.writeFileSync(
      plist,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(server)}</string></array>
  <key>EnvironmentVariables</key><dict>${Object.entries(vars).map(([k, v]) => `<key>${k}</key><string>${xml(v)}</string>`).join('')}</dict>
  <key>WorkingDirectory</key><string>${xml(dataRoot)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(path.join(logs, 'server.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(logs, 'server.log'))}</string>
</dict>
</plist>
`,
      { mode: 0o600 }
    );
    fs.chmodSync(plist, 0o600);
    // bootout returns before the old job has unloaded, and a bootstrap in that window
    // fails with "5: Input/output error". So wait for it to go, then retry a few times.
    spawnSync('launchctl', ['bootout', `${domain}/${LABEL}`]);
    const sleep = (/** @type {number} */ ms) => spawnSync('sleep', [String(ms / 1000)]);
    for (let i = 0; i < 20 && spawnSync('launchctl', ['print', `${domain}/${LABEL}`]).status === 0; i++) sleep(250);
    let r;
    for (let attempt = 0; attempt < 5; attempt++) {
      r = spawnSync('launchctl', ['bootstrap', domain, plist], { encoding: 'utf8' });
      if (r.status === 0) break;
      sleep(1000);
    }
    if (r?.status !== 0) throw new Error(`launchctl bootstrap failed: ${r?.stderr}. Retry with: launchctl bootstrap ${domain} ${plist}`);
    console.log(`Installed ${plist}\nThe server runs at login and restarts if it stops. Logs: ${logs}/server.log`);
    return;
  }
  if (process.platform === 'linux') {
    if (fs.existsSync(OLD_UNIT)) {
      spawnSync('systemctl', ['--user', 'disable', '--now', 'ai-code.service']);
      fs.rmSync(OLD_UNIT);
      console.log('Removed the earlier service (ai-code.service).');
    }
    fs.mkdirSync(path.dirname(unit), { recursive: true });
    fs.writeFileSync(
      unit,
      `[Unit]
Description=Bench
After=network-online.target

[Service]
ExecStart=${node} ${server}
WorkingDirectory=${dataRoot}
${Object.entries(vars).map(([k, v]) => `Environment=${JSON.stringify(`${k}=${v}`)}`).join('\n')}
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
`,
      { mode: 0o600 }
    );
    fs.chmodSync(unit, 0o600);
    // Before the commands, not after: `systemctl --user` needs a running user manager,
    // which a VPS with no login session and no linger does not have. There the first
    // command throws, and a reminder printed afterwards is never seen.
    console.log(`To keep it running after you log out: sudo loginctl enable-linger ${os.userInfo().username}\nIf systemctl cannot reach the user bus, run that first and install again.`);
    for (const args of [['--user', 'daemon-reload'], ['--user', 'enable', '--now', 'bench.service'], ['--user', 'restart', 'bench.service']]) {
      const r = spawnSync('systemctl', args, { encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`systemctl ${args.join(' ')} failed: ${r.stderr}`);
    }
    console.log(`Installed ${unit}\nLogs: journalctl --user -u bench -f`);
    return;
  }
  throw new Error(`No service support for ${process.platform}; run \`bench serve\` under your own process manager.`);
}

function serviceUninstall() {
  if (process.platform === 'darwin') {
    spawnSync('launchctl', ['bootout', `gui/${process.getuid?.()}/${LABEL}`]);
    fs.rmSync(plist, { force: true });
  } else if (process.platform === 'linux') {
    spawnSync('systemctl', ['--user', 'disable', '--now', 'bench.service']);
    fs.rmSync(unit, { force: true });
    spawnSync('systemctl', ['--user', 'daemon-reload']);
  }
  console.log('Service removed.');
}

async function serviceStatus() {
  const installed = process.platform === 'darwin' ? fs.existsSync(plist) : fs.existsSync(unit);
  let running = null;
  try {
    running = await api('GET', '/api/server/status');
  } catch {
    /* not running */
  }
  out({ installed, file: process.platform === 'darwin' ? plist : unit, running: !!running, ...(running ? { pid: running.pid, version: running.version, root: running.root } : {}) });
}

// -- commands ---------------------------------------------------------------------------------

/**
 * The address the tailnet reaches this machine at. Every service on a node shares one
 * hostname, so the port is the only thing that distinguishes them and has to be in the URL.
 * @param {number} httpsPort
 */
function tailscaleUrl(httpsPort) {
  try {
    const name = JSON.parse(execFileSync('tailscale', ['status', '--json'], { encoding: 'utf8' }))?.Self?.DNSName?.replace(/\.$/, '');
    if (!name) return null;
    return `https://${name}${httpsPort === 443 ? '' : `:${httpsPort}`}`;
  } catch {
    return null;
  }
}

/**
 * What `tailscale serve` exposes now, as { 'https:443': 'http://127.0.0.1:4317' }. Null when
 * tailscale is missing or answers in a shape we do not know, which callers read as "cannot
 * tell" and not as "nothing is served", so an unreadable config never blocks a share.
 */
function serveTargets() {
  let raw;
  try {
    raw = execFileSync('tailscale', ['serve', 'status', '--json'], { encoding: 'utf8' });
  } catch {
    return null;
  }
  try {
    /** @type {Record<string, string>} */
    const targets = {};
    for (const [hostPort, entry] of Object.entries(JSON.parse(raw)?.Web || {})) {
      const root = entry?.Handlers?.['/'];
      const target = root?.Proxy || root?.Text || root?.Path || null;
      if (target) targets[`https:${String(hostPort).slice(String(hostPort).lastIndexOf(':') + 1)}`] = String(target);
    }
    return targets;
  } catch {
    return null;
  }
}

/**
 * An interactive `claude` on one provider: its cheapest enabled model, with the ambient
 * routing a shell may carry stripped, so a key that is missing fails loudly instead of
 * falling back to the subscription login. `--model` in the arguments still wins.
 * @param {string|undefined} providerId @param {string[]} args
 */
async function shell(providerId, args) {
  if (!providerId) throw new Error('Usage: bench shell <provider-id> [claude args]');
  const { Store } = await import('./store.mjs');
  const { cleanEnv, providerEnv } = await import('./providers.mjs');
  const store = new Store(dataRoot);
  const provider = store.getProvider(providerId);
  if (!provider) throw new Error(`No provider ${providerId}`);
  const models = store.listModels(providerId).filter((m) => m.enabled);
  const model = models.sort((a, b) => (a.input_cost_per_mtok ?? Infinity) - (b.input_cost_per_mtok ?? Infinity))[0] || null;
  const r = spawnSync('claude', args, { stdio: 'inherit', env: { ...cleanEnv(), ...providerEnv(provider, model) } });
  process.exitCode = r.status ?? 1;
}

async function main() {
  const [cmd = 'serve', ...rest] = process.argv.slice(2);
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') return out(HELP);
  if (cmd === 'serve' || cmd === 'web' || cmd === 'dashboard') {
    process.env.BENCH_ROOT = dataRoot;
    await import('./server.mjs');
    return;
  }
  if (cmd === 'open') {
    spawnSync(process.platform === 'darwin' ? 'open' : 'xdg-open', [`http://localhost:${port}`]);
    return;
  }
  if (cmd === 'add' || cmd === 'init') {
    // `init <name> <path>` is the old spelling; `add <path> [name]` the new one.
    const [a, b] = rest.filter((x) => !x.startsWith('--'));
    const [dir, name] = cmd === 'init' ? [b, a] : [a, b];
    if (!dir) throw new Error('Usage: bench add <path> [name]');
    const s = await service();
    out(s.addProject({ path: dir, name, init: rest.includes('--init') }));
    s.shutdown();
    return;
  }
  if (cmd === 'projects') {
    const s = await service();
    out(s.store.listProjects());
    s.shutdown();
    return;
  }
  if (cmd === 'pair') {
    const r = await api('POST', '/api/pairing', {});
    if (!r.urls.length) {
      out(`Pairing code: ${r.code} (valid 10 minutes)\nNo address for other devices is known. Run \`bench share\`, or set BENCH_PUBLIC_URL, then try again.`);
      return;
    }
    const QRCode = (await import('qrcode')).default;
    console.log(await QRCode.toString(r.urls[0], { type: 'terminal', small: true }));
    out(`Open on the device you want to pair (valid 10 minutes, works once):\n${r.urls.join('\n')}`);
    return;
  }
  if (cmd === 'share') {
    const off = rest.includes('--off');
    const force = rest.includes('--force');
    const at = rest.indexOf('--port');
    const sharePort = at === -1 ? 443 : Number(rest[at + 1]);
    if (!Number.isInteger(sharePort) || sharePort < 1 || sharePort > 65535) throw new Error('Usage: bench share [--port <n>] [--force] [--off]');
    const backend = `http://127.0.0.1:${port}`;
    // A port belongs to whoever claimed it. 443 is as likely to hold someone's dashboard as
    // it is to be free, and serving there replaces that outright, so replace only if asked.
    const existing = serveTargets()?.[`https:${sharePort}`];
    if (existing && existing !== backend && !force) {
      throw new Error(
        off
          ? `tailscale serve https:${sharePort} is ${existing}, which bench did not set up. Use --force to turn it off anyway.`
          : `tailscale serve already points https:${sharePort} at ${existing}.\nGive bench its own port:  bench share --port 8443\nOr take that port over:   bench share --force`
      );
    }
    const args = off ? ['serve', `--https=${sharePort}`, 'off'] : ['serve', '--bg', `--https=${sharePort}`, backend];
    const r = spawnSync('tailscale', args, { stdio: 'inherit' });
    if (r.error) throw new Error('tailscale is not installed. See https://tailscale.com/download');
    if (r.status !== 0) process.exit(r.status || 1);
    if (!off) {
      const url = tailscaleUrl(sharePort);
      out(
        `Shared on your tailnet: ${url || '(see `tailscale serve status`)'}\n` +
          (sharePort === 443 ? '' : `Devices reach it on that port, so set BENCH_PUBLIC_URL=${url} or the pairing link will point at 443.\n`) +
          'Next: `bench pair` to let a device in.'
      );
    }
    return;
  }
  if (cmd === 'devices') return out(await api('GET', '/api/devices'));
  if (cmd === 'revoke') return out(await api('DELETE', `/api/devices/${encodeURIComponent(rest[0] || '')}`));
  if (cmd === 'doctor') {
    const s = await service();
    const { checks } = await s.doctor();
    s.shutdown();
    for (const c of checks) console.log(`${c.ok ? 'ok  ' : c.optional ? '--  ' : 'FAIL'} ${c.name}: ${c.detail}`);
    if (checks.some((c) => !c.ok && !c.optional)) process.exitCode = 1;
    return;
  }
  if (cmd === 'shell') return shell(rest[0], rest.slice(1));
  if (cmd === 'service') {
    if (rest[0] === 'install') return serviceInstall();
    if (rest[0] === 'uninstall') return serviceUninstall();
    if (rest[0] === 'status') return serviceStatus();
  }
  out(HELP);
  process.exitCode = 2;
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
