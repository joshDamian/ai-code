// @ts-check
import fs from 'node:fs';
import path from 'node:path';

// Configuration from the environment. Every variable is BENCH_<NAME>; the AI_CODE_<NAME>
// spelling from before the rename is still read, so an existing setup keeps working.

/** @param {string} name without the prefix, e.g. 'ROOT' @returns {string|undefined} */
export function env(name) {
  return process.env[`BENCH_${name}`] ?? process.env[`AI_CODE_${name}`];
}

// Provider API keys and any other settings the server needs, kept in one file in the
// data folder rather than in a shell profile. A service is started by systemd or launchd,
// which read no profile, and a non-interactive bash returns from ~/.bashrc before its
// end. The file is read by the server itself at startup, however it was started.
export const PROVIDER_KEYS = ['DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY', 'FIREWORKS_API_KEY'];

/** @param {string} root the data folder */
export const envFile = (root) => path.join(root, 'env');

/**
 * KEY=value lines. `export ` in front, quotes around the value, blank lines and # comments
 * are all accepted, so a line copied from a shell profile works as it is.
 * @param {string} text @returns {Record<string, string>}
 */
export function parseEnv(text) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(raw);
    if (!m || raw.trim().startsWith('#')) continue;
    let v = m[2];
    if (/^"(.*)"$/.test(v)) v = v.slice(1, -1).replace(/\\(["\\$`])/g, '$1');
    else if (/^'(.*)'$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]] = v;
  }
  return out;
}

/** @param {string} root @returns {Record<string, string>} */
export function readEnvFile(root) {
  try {
    return parseEnv(fs.readFileSync(envFile(root), 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Puts the file's variables into process.env. One already set in the environment wins,
 * as with any .env file, so a key exported in the shell that ran `bench serve` still
 * counts. @param {string} root @returns {string[]} the names it set
 */
export function loadEnvFile(root) {
  const set = [];
  for (const [k, v] of Object.entries(readEnvFile(root))) {
    if (process.env[k] === undefined && v !== '') {
      process.env[k] = v;
      set.push(k);
    }
  }
  return set;
}

/**
 * Adds variables to the file, leaving any it already has. Owner-only: it holds API keys.
 * @param {string} root @param {Record<string, string>} vars @returns {string[]} the names added
 */
export function addToEnvFile(root, vars) {
  const have = readEnvFile(root);
  const add = Object.entries(vars).filter(([k, v]) => v && !have[k]);
  if (!add.length) return [];
  const file = envFile(root);
  fs.mkdirSync(root, { recursive: true });
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    text = '# Read by the Bench server at startup. One KEY=value per line.\n';
  }
  if (text && !text.endsWith('\n')) text += '\n';
  text += add.map(([k, v]) => `${k}=${/^[\w@%+=:,./-]*$/.test(v) ? v : `"${v.replace(/(["\\$`])/g, '\\$1')}"`}`).join('\n') + '\n';
  fs.writeFileSync(file, text, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return add.map(([k]) => k);
}
