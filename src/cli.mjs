#!/usr/bin/env node
// @ts-check
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { env, envFile, loadEnvFile, addToEnvFile, PROVIDER_KEYS } from './env.mjs';

// The command line. Most of the tool lives in the browser; this starts the server,
// registers projects, pairs devices and installs the service.

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');
const port = Number(process.env.PORT || 4317);
const dataRoot = env('ROOT') || process.cwd();
loadEnvFile(dataRoot);

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
  bench tasks [project]       active tasks, newest first (--all adds merged and closed)
  bench task <id>             a task's branch, worktree, check, git state and sessions
  bench task close <id>       close it: worktree removed, sessions archived (--delete-branch)
  bench task merge <id>       merge it into its base and clean up
                              --squash, --message <m>, --keep (leave worktree and sessions)
  bench task check <id>       run its check now; exits 1 if it fails
  bench task loop <id>        keep going until its check passes: a failure sends the
                              session back to work (--max-attempts <n>, --max-minutes <m>,
                              --off to stop it). Needs a check; the person sets it, not a session
  bench sessions [project]    open sessions (--all adds archived ones)
  bench update                whether Bench can update from its checkout (--yes to do it)
  bench doctor                check git, node, claude, gh and the providers
  bench shell <provider> [..] an interactive \`claude\` billed to that provider

Environment: PORT (default 4317), BENCH_ROOT (where the database lives),
BENCH_PUBLIC_URL (the address other devices reach this server at).

Task and session commands go through the running server. Ids may be shortened to any
unique prefix of 4 or more characters. --json prints the server's raw answer.`;

/** @param {unknown} x */
const out = (x) => console.log(typeof x === 'string' ? x : JSON.stringify(x, null, 2));

/**
 * A call to the running server, over loopback, which needs no token. Over node:http
 * rather than fetch, whose five-minute header timeout a task's check can outlast.
 * @param {string} method @param {string} p @param {unknown} [body] @returns {Promise<any>}
 */
function api(method, p, body) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: payload === undefined ? {} : { 'content-type': 'application/json' } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (text += d));
      res.on('end', () => {
        let data = null;
        try {
          data = JSON.parse(text);
        } catch {}
        if ((res.statusCode || 500) >= 400) reject(new Error(data?.error || `Server answered ${res.statusCode}`));
        else resolve(data);
      });
    });
    req.on('error', () => reject(new Error(`No server on port ${port}. Start it with \`bench serve\` or \`bench service install\`.`)));
    req.end(payload);
  });
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

/**
 * Provider keys live in the data folder's env file, which the server reads itself, not
 * in the service definition: that was written from whatever shell ran the install, and
 * a reinstall from a shell without them (a script, cron, systemd-run, a bash that
 * returned early from ~/.bashrc) silently dropped them. Keys found in this shell or in
 * the service being replaced are moved into the file, so none is lost.
 */
function keepProviderKeys() {
  /** @type {Record<string, string>} */
  const found = {};
  const old = serviceDefinitionVars();
  for (const k of PROVIDER_KEYS) {
    const v = process.env[k] || old[k];
    if (v) found[k] = String(v);
  }
  const added = addToEnvFile(dataRoot, found);
  if (added.length) console.log(`Saved ${added.join(', ')} to ${envFile(dataRoot)}`);
  const have = PROVIDER_KEYS.filter((k) => process.env[k] || found[k]);
  console.log(have.length ? `Provider keys: ${have.join(', ')} (from ${envFile(dataRoot)})` : `No provider API keys found. To use DeepSeek, OpenRouter or Fireworks, add e.g. DEEPSEEK_API_KEY=... to ${envFile(dataRoot)} and restart the server.`);
}

/** The variables in the service definition already installed, if any. @returns {Record<string, string>} */
function serviceDefinitionVars() {
  /** @type {Record<string, string>} */
  const out = {};
  try {
    if (process.platform === 'darwin') {
      const text = fs.readFileSync(plist, 'utf8');
      const dict = /<key>EnvironmentVariables<\/key><dict>(.*?)<\/dict>/s.exec(text)?.[1] || '';
      for (const m of dict.matchAll(/<key>([^<]+)<\/key><string>([^<]*)<\/string>/g)) out[m[1]] = m[2].replace(/&lt;/g, '<').replace(/&amp;/g, '&');
    } else {
      for (const line of fs.readFileSync(unit, 'utf8').split('\n')) {
        const m = /^Environment=(".*")$/.exec(line);
        if (!m) continue;
        const kv = JSON.parse(m[1]);
        const i = kv.indexOf('=');
        if (i > 0) out[kv.slice(0, i)] = kv.slice(i + 1);
      }
    }
  } catch {
    /* none installed */
  }
  return out;
}

function serviceInstall() {
  const node = process.execPath;
  const server = path.join(appRoot, 'src', 'server.mjs');
  // The PATH of this shell goes with it: the service starts `claude`, `git` and `gh`, and
  // a service manager gives a job almost no PATH of its own.
  /** @type {Record<string, string>} */
  // BENCH_SERVICE tells the server a service manager will restart it, which is what
  // makes the Restart button in Settings safe to offer.
  const vars = { BENCH_ROOT: dataRoot, PORT: String(port), PATH: process.env.PATH || '/usr/bin:/bin', BENCH_SERVICE: process.platform === 'darwin' ? 'launchd' : 'systemd' };
  keepProviderKeys();
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

// -- tasks, sessions and updates, through the running server ----------------------------------
//
// Never through a Service of their own: the server owns live sessions and tells every open
// page what changed, and a second process changing the database behind its back leaves
// sessions working in removed worktrees and pages out of date.

/**
 * Words and flags. `valued` names the flags that take the next word as their value.
 * @param {string[]} args @param {string[]} [valued]
 */
function parseArgs(args, valued = []) {
  /** @type {string[]} */
  const words = [];
  /** @type {Record<string, string|true>} */
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) words.push(a);
    else if (valued.includes(a.slice(2))) {
      if (i + 1 >= args.length) throw new Error(`${a} needs a value`);
      flags[a.slice(2)] = args[++i];
    } else flags[a.slice(2)] = true;
  }
  return { words, flags };
}

const shortId = (/** @type {string} */ id) => id.slice(0, 8);
const shortCommit = (/** @type {string|null|undefined} */ c) => (c ? c.slice(0, 7) : 'unknown');
const plural = (/** @type {number} */ n, /** @type {string} */ word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Lines of aligned columns. @param {string[][]} rows */
function table(rows) {
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((r) => r[i].length))) || [];
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]))).join('  ')).join('\n');
}

/**
 * The one item whose id is `given` or starts with it, as git takes a commit. A prefix
 * shorter than four characters matches too much to be safe, and an ambiguous one lists
 * what it matches.
 * @template {{id: string}} T
 * @param {string|undefined} given @param {T[]} items @param {string} kind @param {(x: T) => string} describe
 * @returns {T}
 */
function byId(given, items, kind, describe) {
  if (!given) throw new Error(`Give a ${kind} id`);
  const exact = items.find((x) => x.id === given);
  if (exact) return exact;
  if (given.length < 4) throw new Error(`A ${kind} id needs at least 4 characters: ${given}`);
  const found = items.filter((x) => x.id.startsWith(given)).sort((a, b) => a.id.localeCompare(b.id));
  if (found.length === 1) return found[0];
  if (!found.length) throw new Error(`No ${kind} matches ${given}`);
  throw new Error(`${given} matches ${found.length} ${kind}s:\n${found.map((x) => `  ${shortId(x.id)}  ${describe(x)}`).join('\n')}`);
}

/** A project by name or id. @param {string} given */
async function findProject(given) {
  /** @type {{id: string, name: string, path: string}[]} */
  const projects = await api('GET', '/api/projects');
  const named = projects.filter((p) => p.name === given);
  if (named.length === 1) return named[0];
  if (named.length > 1) throw new Error(`${named.length} projects are called ${given}; give its id:\n${named.map((p) => `  ${shortId(p.id)}  ${p.path}`).join('\n')}`);
  return byId(given, projects, 'project', (p) => `${p.name} (${p.path})`);
}

/** @param {string} given */
async function findTask(given) {
  /** @type {import('./contract.mjs').Task[]} */
  const tasks = await api('GET', '/api/tasks');
  return byId(given, tasks, 'task', (t) => `${t.state}  ${t.title}`);
}

/** @param {import('./contract.mjs').Task} t */
const checkWord = (t) => (!t.check_command ? 'no check' : t.check_status || 'unchecked');

/** A task's loop in a word, for the detail view. @param {import('./contract.mjs').Task} t */
function loopWord(t) {
  const l = t.loop;
  if (!l) return 'off';
  if (l.state === 'looping') return `looping, attempt ${l.attempts} of ${l.max_attempts} (up to ${plural(l.max_minutes, 'minute')})`;
  if (l.state === 'done') return `done: the check passed after ${plural(l.attempts, 'attempt')}`;
  return `${l.state === 'gave-up' ? 'gave up' : 'stopped'}${l.reason ? `: ${l.reason}` : ''}`;
}

const newestFirst = (/** @type {{created_at: string}} */ a, /** @type {{created_at: string}} */ b) => b.created_at.localeCompare(a.created_at);

/** @param {string[]} args */
async function tasksCmd(args) {
  const { words, flags } = parseArgs(args);
  const project = words[0] ? await findProject(words[0]) : null;
  /** @type {import('./contract.mjs').Task[]} */
  const all = await api('GET', `/api/tasks${project ? `?projectId=${encodeURIComponent(project.id)}` : ''}`);
  const tasks = all.filter((t) => flags.all || t.state === 'active').sort(newestFirst);
  if (flags.json) return out(tasks);
  if (!tasks.length) return out(flags.all ? 'No tasks.' : 'No active tasks. --all includes merged and closed ones.');
  out(table(tasks.map((t) => [shortId(t.id), t.state, checkWord(t), t.title])));
}

/** The last lines of a check's output. @param {string|null} output */
const tail = (output, lines = 20) => (output || '').trimEnd().split('\n').slice(-lines).join('\n');

/** @param {string[]} args */
async function taskCmd(args) {
  const [sub, ...rest] = args;
  if (sub === 'close') {
    const { words, flags } = parseArgs(rest);
    const t = await findTask(words[0]);
    const r = await api('POST', `/api/tasks/${t.id}/close`, { deleteBranch: !!flags['delete-branch'] });
    if (flags.json) return out(r);
    return out(`Closed ${shortId(t.id)} ${t.title}: worktree removed, sessions archived${flags['delete-branch'] ? `, branch ${t.branch} deleted` : `; branch ${t.branch} kept`}.`);
  }
  if (sub === 'merge') {
    const { words, flags } = parseArgs(rest, ['message']);
    const t = await findTask(words[0]);
    /** @type {{strategy: string, cleanup: boolean, message?: string}} */
    const body = { strategy: flags.squash ? 'squash' : 'merge', cleanup: !flags.keep };
    if (typeof flags.message === 'string') body.message = flags.message;
    const r = await api('POST', `/api/tasks/${t.id}/merge`, body);
    if (flags.json) return out(r);
    return out(`Merged ${shortId(t.id)} ${t.title} into ${t.base_branch}${r.commit ? ` at ${shortCommit(r.commit)}` : ''}.${flags.keep ? ' Worktree and sessions kept.' : ' Worktree removed, sessions archived.'}`);
  }
  if (sub === 'check') {
    const { words, flags } = parseArgs(rest);
    const t = await findTask(words[0]);
    /** @type {import('./contract.mjs').Task} */
    const r = await api('POST', `/api/tasks/${t.id}/check`, {});
    if (r.check_status !== 'passed') process.exitCode = 1;
    if (flags.json) return out(r);
    const end = tail(r.check_output);
    return out(`${r.check_status === 'passed' ? 'Passed' : 'Failed'}: ${r.check_command}${end ? `\n\n${end}` : ''}`);
  }
  if (sub === 'loop') {
    const { words, flags } = parseArgs(rest, ['max-attempts', 'max-minutes']);
    const t = await findTask(words[0]);
    if (flags.off) {
      /** @type {import('./contract.mjs').Task} */
      const off = await api('PATCH', `/api/tasks/${t.id}`, { loop: null });
      if (flags.json) return out(off);
      return out(`Loop off for ${shortId(t.id)} ${t.title}.${t.loop ? ' What it got through stays in the task log.' : ''}`);
    }
    const int = (/** @type {unknown} */ v, /** @type {string} */ name) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} takes a whole number of at least 1`);
      return n;
    };
    /** @type {{max_attempts?:number, max_minutes?:number}} */
    const caps = {};
    if (flags['max-attempts'] !== undefined) caps.max_attempts = int(flags['max-attempts'], 'max-attempts');
    if (flags['max-minutes'] !== undefined) caps.max_minutes = int(flags['max-minutes'], 'max-minutes');
    /** @type {import('./contract.mjs').Task} */
    const r = await api('PATCH', `/api/tasks/${t.id}`, { loop: caps });
    if (flags.json) return out(r);
    const loop = r.loop;
    // A loop nothing can feed stops the moment it is turned on; saying "Looping" would be a
    // promise the task cannot keep.
    if (loop?.state !== 'looping') throw new Error(`The loop did not start: ${loop?.reason || 'the task has nothing to loop'}`);
    return out(`Looping ${shortId(t.id)} ${t.title}: \`${r.check_command}\` runs when its session goes idle, and a failure sends it back to work — up to ${plural(loop.max_attempts, 'attempt')} or ${plural(loop.max_minutes, 'minute')}. Then it writes up why it is stuck and stops. \`bench task loop ${shortId(t.id)} --off\` ends it.`);
  }
  const { words, flags } = parseArgs(args);
  const t = await findTask(words[0]);
  /** @type {{task: import('./contract.mjs').Task, git: any, sessions: import('./contract.mjs').Session[]}} */
  const r = await api('GET', `/api/tasks/${t.id}`);
  if (flags.json) return out(r);
  const { task, git, sessions } = r;
  const gone = !fs.existsSync(task.worktree);
  const state = [`${git.ahead} ahead`, `${git.behind} behind`, git.dirty.length ? `${plural(git.dirty.length, 'uncommitted file')}` : 'clean'];
  if (git.conflicted.length) state.push(`${plural(git.conflicted.length, 'conflict')}`);
  const lines = [
    task.title,
    '',
    table([
      ['id', task.id],
      ['state', task.state + (task.merge_commit ? ` (${shortCommit(task.merge_commit)})` : '')],
      ['branch', `${task.branch} → ${task.base_branch}`],
      ['worktree', `${task.worktree}${gone ? ' (removed)' : ''}`],
      ['done means', task.done || '-'],
      ['check', task.check_command || '-'],
      ['last check', task.check_command ? `${checkWord(task)}${task.check_at ? ` at ${task.check_at}` : ''}` : '-'],
      ['loop', loopWord(task)],
      ['git', state.join(', ')],
    ]),
    '',
    sessions.length ? `Sessions:\n${table(sessions.sort(newestFirst).map((s) => ['  ' + shortId(s.id), s.archived_at ? 'archived' : s.status, s.title]))}` : 'No sessions.',
  ];
  out(lines.join('\n'));
}

/** @param {string[]} args */
async function sessionsCmd(args) {
  const { words, flags } = parseArgs(args);
  const project = words[0] ? await findProject(words[0]) : null;
  const q = new URLSearchParams();
  if (project) q.set('projectId', project.id);
  if (flags.all) q.set('archived', '1');
  /** @type {import('./contract.mjs').Session[]} */
  const sessions = (await api('GET', `/api/sessions${q.size ? `?${q}` : ''}`)).sort(newestFirst);
  if (flags.json) return out(sessions);
  if (!sessions.length) return out('No sessions.');
  out(table(sessions.map((s) => [shortId(s.id), s.archived_at ? 'archived' : s.status, s.task_id ? `task ${shortId(s.task_id)}` : '-', s.title])));
}

/** What Settings → Update shows. @param {import('./update.mjs').UpdateStatus} st */
function describeUpdate(st) {
  const lines = [];
  if (st.installed) {
    lines.push(`Installed ${shortCommit(st.installed.commit)}${st.installed.dirty ? ' with uncommitted changes' : ''}, at ${st.installed.installedAt}.`);
    lines.push(`Checkout ${st.source} is at ${shortCommit(st.sourceCommit)}${st.newer === 0 ? ', the same commit' : st.newer ? `, ${plural(st.newer, 'newer commit')}` : ''}.`);
    if (st.sourceDirty) lines.push('The checkout has uncommitted changes. An update installs the files as they are, changes included.');
  }
  lines.push(st.canUpdate ? 'Run `bench update --yes` to install it and restart the server.' : `Cannot update: ${st.reason}`);
  if (st.last && !st.last.running && st.last.exit !== 0) lines.push('', `The last update failed (exit ${st.last.exit}, ${st.last.at}):`, st.last.tail);
  return lines.join('\n');
}

/**
 * Waits for a server running `commit` to answer, or for the update log to say the install
 * failed, in which case the old server is still up. The Settings page waits the same way.
 * @param {string|null} commit @param {number} oldPid
 * @returns {Promise<'updated'|'failed'|'timeout'>}
 */
async function updatedTo(commit, oldPid, ms = 5 * 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const s = await api('GET', '/api/server/status');
      if (s.pid !== oldPid && (!commit || s.commit === commit)) return 'updated';
      const u = await api('GET', '/api/server/update');
      if (u.last && !u.last.running && u.last.exit !== 0) return 'failed';
    } catch {
      /* restarting */
    }
  }
  return 'timeout';
}

/** @param {string[]} args */
async function updateCmd(args) {
  const { flags } = parseArgs(args);
  /** @type {import('./update.mjs').UpdateStatus} */
  const st = await api('GET', '/api/server/update');
  if (!flags.yes) return out(flags.json ? st : describeUpdate(st));
  if (!st.canUpdate) throw new Error(`Cannot update: ${st.reason}`);
  const before = await api('GET', '/api/server/status');
  // A session's shell is a child of the server it would restart.
  if (env('PROVIDER')) console.error('This shell is inside a Bench session: the update restarts the server this session runs on.');
  const started = await api('POST', '/api/server/update', {});
  if (!flags.json) console.log(`Updating from ${started.source} (${shortCommit(started.from)} → ${shortCommit(started.to)}); waiting for the server to come back…`);
  const result = await updatedTo(started.to, before.pid);
  /** @type {import('./update.mjs').UpdateStatus|null} */
  const after = await api('GET', '/api/server/update').catch(() => null);
  if (result !== 'updated') process.exitCode = 1;
  if (flags.json) return out({ ...started, result, status: after });
  if (result === 'updated') return out(`Updated to ${shortCommit(started.to)}.`);
  console.error(result === 'failed' ? 'The update failed; the old server is still running. The installer log:' : 'The server has not come back on the new commit. The installer log:');
  console.error(after?.last?.tail || '(no log)');
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
  if (cmd === 'tasks') return tasksCmd(rest);
  if (cmd === 'task') return taskCmd(rest);
  if (cmd === 'sessions') return sessionsCmd(rest);
  if (cmd === 'update') return updateCmd(rest);
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
