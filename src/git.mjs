// @ts-check
import { execFileSync, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { env } from './env.mjs';

/** @typedef {import('./contract.mjs').GitState} GitState */
/** @typedef {import('./contract.mjs').GitBranch} GitBranch */

// Git, run as a child process. Synchronous for the local reads and writes, which are
// fast; asynchronous for anything that talks to a remote, which may not be.

/** @param {string} cwd @param {string[]} args @param {{env?:NodeJS.ProcessEnv, input?:string}} [o] */
export function git(cwd, args, o = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    env: o.env || process.env,
    input: o.input,
  }).trimEnd();
}

/** The error git printed, rather than Node's "Command failed: git ..." wrapper. @param {any} e */
export function gitError(e) {
  const text = String(e?.stderr || e?.stdout || e?.message || e).trim();
  return text.replace(/^(error|fatal): /gm, '').split('\n').slice(0, 6).join('\n');
}

/** @param {string} cwd @param {string[]} args @param {number} [timeoutMs] @returns {Promise<string>} */
export function gitAsync(cwd, args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    // No prompt for credentials: a server has nobody at the terminal to answer one.
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    execFile('git', args, { cwd, env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(new Error(gitError({ stderr, stdout, message: err.message })), { code: 'GIT' }));
      else resolve(String(stdout).trimEnd());
    });
  });
}

/** @param {string} dir */
export function isRepo(dir) {
  try {
    return git(dir, ['rev-parse', '--is-inside-work-tree']) === 'true';
  } catch {
    return false;
  }
}

/** @param {string} dir */
export const topLevel = (dir) => git(dir, ['rev-parse', '--show-toplevel']);

/** @param {string} dir @param {string} [ref] @returns {string|null} */
export function revParse(dir, ref = 'HEAD') {
  try {
    return git(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]) || null;
  } catch {
    return null;
  }
}

/** @param {string} dir @returns {string|null} */
export function currentBranch(dir) {
  try {
    return git(dir, ['symbolic-ref', '--short', '-q', 'HEAD']) || null;
  } catch {
    return null;
  }
}

/** @param {string} dir @param {string} a @param {string} b */
export function isAncestor(dir, a, b) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', a, b], { cwd: dir, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** @param {string} dir @param {string} a @param {string} b @returns {string|null} */
export function mergeBase(dir, a, b) {
  try {
    return git(dir, ['merge-base', a, b]) || null;
  } catch {
    return null;
  }
}

/** @param {string} dir @param {string} range */
const count = (dir, range) => Number(git(dir, ['rev-list', '--count', range])) || 0;

/** @param {string} dir */
export function hasRemote(dir) {
  try {
    return !!git(dir, ['remote']);
  } catch {
    return false;
  }
}

/**
 * The working tree in one read: branch, upstream, ahead/behind, and the paths that
 * differ from HEAD. `git status --porcelain=v2 --branch -z` carries all of it.
 * @param {string} dir
 */
export function status(dir) {
  const out = git(dir, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']);
  const parts = out.split('\0');
  /** @type {{branch:string|null, head:string|null, upstream:string|null, ahead:number, behind:number, dirty:string[], conflicted:string[]}} */
  const s = { branch: null, head: null, upstream: null, ahead: 0, behind: 0, dirty: [], conflicted: [] };
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    if (!line) continue;
    if (line.startsWith('# branch.oid ')) s.head = line.slice(13) === '(initial)' ? null : line.slice(13);
    else if (line.startsWith('# branch.head ')) s.branch = line.slice(14) === '(detached)' ? null : line.slice(14);
    else if (line.startsWith('# branch.upstream ')) s.upstream = line.slice(18);
    else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) [s.ahead, s.behind] = [Number(m[1]), Number(m[2])];
    } else if (line.startsWith('1 ')) s.dirty.push(line.split(' ').slice(8).join(' '));
    else if (line.startsWith('2 ')) {
      // A rename: the new path here, the old one in the next NUL-separated field.
      s.dirty.push(line.split(' ').slice(9).join(' '));
      i++;
    } else if (line.startsWith('u ')) {
      const p = line.split(' ').slice(10).join(' ');
      s.conflicted.push(p);
      s.dirty.push(p);
    } else if (line.startsWith('? ')) s.dirty.push(line.slice(2));
  }
  return s;
}

/**
 * Branches a task can start from or a checkout can switch to. A remote branch with no
 * local counterpart is listed once, marked, so choosing it can create the local one.
 * Task branches are left out: offering one as a base is offering a task's own branch.
 * @param {string} dir @returns {GitBranch[]}
 */
export function branches(dir) {
  const cur = currentBranch(dir);
  const local = git(dir, ['for-each-ref', '--format=%(refname:short)', '--sort=-committerdate', 'refs/heads']).split('\n').filter(Boolean);
  const remote = git(dir, ['for-each-ref', '--format=%(refname:short)', '--sort=-committerdate', 'refs/remotes'])
    .split('\n')
    .filter((r) => r && !r.endsWith('/HEAD') && r.includes('/'));
  const have = new Set(local);
  /** @type {GitBranch[]} */
  const out = local.filter((b) => !isTaskBranch(b)).map((name) => ({ name, remoteOnly: false, current: name === cur }));
  for (const r of remote) {
    const name = r.slice(r.indexOf('/') + 1);
    if (have.has(name) || isTaskBranch(name)) continue;
    have.add(name);
    out.push({ name, remoteOnly: true, current: false });
  }
  return out;
}

/** A task's own branch: `bench/…`, or `ai-code/…` from before the rename. @param {string} b */
const isTaskBranch = (b) => b.startsWith('bench/') || b.startsWith('ai-code/');

/** The checkout state a project page shows. @param {string} dir @returns {GitState} */
export function gitState(dir) {
  const s = status(dir);
  return { ...s, branches: branches(dir), hasRemote: hasRemote(dir) };
}

/** Where each branch is checked out, across the repository's worktrees. @param {string} dir @returns {Map<string,string>} */
export function checkedOutAt(dir) {
  const map = new Map();
  let at = null;
  for (const l of git(dir, ['worktree', 'list', '--porcelain']).split('\n')) {
    if (l.startsWith('worktree ')) at = l.slice(9);
    else if (l.startsWith('branch refs/heads/') && at) map.set(l.slice(18), at);
  }
  return map;
}

/**
 * Makes a local branch for one that exists only on a remote. A no-op for a local one.
 * @param {string} dir @param {string} name
 */
export function ensureLocalBranch(dir, name) {
  if (revParse(dir, `refs/heads/${name}`)) return;
  const remote = git(dir, ['for-each-ref', '--format=%(refname:short)', `refs/remotes/*/${name}`]).split('\n').filter(Boolean)[0];
  if (!remote) throw new Error(`No branch named ${name}`);
  git(dir, ['branch', '--track', name, remote]);
}

/**
 * Switches the checkout. Refuses over uncommitted changes unless `stash`, which keeps
 * them in a named stash entry, because a switch that silently carried them would put
 * one branch's half-done work on another.
 * @param {string} dir @param {string} name @param {{create?:boolean, from?:string, stash?:boolean}} [o]
 */
export function checkout(dir, name, o = {}) {
  const s = status(dir);
  if (s.conflicted.length) throw new Error(`Resolve the conflicts first: ${s.conflicted.join(', ')}`);
  let stashed = false;
  if (s.dirty.length) {
    if (!o.stash) throw Object.assign(new Error(`${s.dirty.length} uncommitted change${s.dirty.length === 1 ? '' : 's'} on ${s.branch || 'HEAD'}`), { code: 'DIRTY', dirty: s.dirty });
    git(dir, ['stash', 'push', '--include-untracked', '-m', `bench: switching from ${s.branch || 'HEAD'} to ${name}`]);
    stashed = true;
  }
  try {
    if (o.create) git(dir, ['switch', '-c', name, ...(o.from ? [o.from] : [])]);
    else {
      ensureLocalBranch(dir, name);
      git(dir, ['switch', name]);
    }
  } catch (e) {
    if (stashed) git(dir, ['stash', 'pop']);
    throw new Error(gitError(e));
  }
  return { branch: name, stashed };
}

/** @param {string} dir */
export const fetchAll = (dir) => gitAsync(dir, ['fetch', '--all', '--prune']);

/** Fast-forward only: a pull that would merge is a decision, not a refresh. @param {string} dir */
export const pull = (dir) => gitAsync(dir, ['pull', '--ff-only']);

/** @param {string} dir @param {string} branch */
export async function push(dir, branch) {
  const remote = git(dir, ['remote']).split('\n')[0] || 'origin';
  return gitAsync(dir, ['push', '-u', remote, branch]);
}

/** Stages everything, untracked included, and commits. Null when there is nothing. @param {string} dir @param {string} message */
export function commitAll(dir, message) {
  if (!status(dir).dirty.length) return null;
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']);
}

// -- worktrees ------------------------------------------------------------------

/** Where a project's task worktrees go: beside the checkout, never inside it. @param {string} repo */
export function worktreeRoot(repo) {
  return env('WORKTREE_ROOT') || path.join(path.dirname(repo), `.bench-worktrees-${path.basename(repo)}`);
}

/**
 * A new branch at `base`, checked out in its own directory. The checkout's
 * node_modules is linked in, so a task can run the project's tests without an install.
 * @param {string} repo @param {string} dir @param {string} branch @param {string} base
 */
export function createWorktree(repo, dir, branch, base) {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  git(repo, ['worktree', 'add', '-q', '-b', branch, dir, base]);
  const nm = path.join(repo, 'node_modules');
  const link = path.join(dir, 'node_modules');
  if (fs.existsSync(nm) && !fs.existsSync(link)) {
    excludeLine(repo, '/node_modules');
    try {
      fs.symlinkSync(nm, link, 'junction');
    } catch {
      /* the task can install its own */
    }
  }
}

/** @param {string} repo @param {string} dir */
export function removeWorktree(repo, dir) {
  if (fs.existsSync(dir)) git(repo, ['worktree', 'remove', '--force', dir]);
  else git(repo, ['worktree', 'prune']);
}

/** @param {string} repo @param {string} branch */
export function deleteBranch(repo, branch) {
  git(repo, ['branch', '-D', branch]);
}

/** A line in the repository's own ignore file, which is never committed. @param {string} repo @param {string} line */
export function excludeLine(repo, line) {
  try {
    const common = git(repo, ['rev-parse', '--git-common-dir']);
    const f = path.resolve(repo, common, 'info', 'exclude');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const s = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
    if (s.split('\n').some((x) => x.trim() === line)) return;
    fs.appendFileSync(f, (s && !s.endsWith('\n') ? '\n' : '') + line + '\n');
  } catch {
    /* nothing to protect */
  }
}

// -- diffs ----------------------------------------------------------------------

/**
 * The working tree against `ref`, new files included. Read through a throwaway index so
 * the person's own staging is never touched: `git add -A` into a copy, then diff it.
 * @param {string} dir @param {string} ref @param {string[]} [extra] extra `git diff` flags
 */
function diffWorking(dir, ref, extra = []) {
  const tmp = path.join(os.tmpdir(), `bench-index-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const env = { ...process.env, GIT_INDEX_FILE: tmp };
  try {
    git(dir, ['read-tree', ref], { env });
    git(dir, ['add', '-A'], { env });
    return git(dir, ['diff', '--cached', '--no-color', '--no-ext-diff', ...extra, ref], { env });
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** @param {string} dir @param {string} ref */
export const workingDiff = (dir, ref) => diffWorking(dir, ref);

/**
 * The id of the tree the working directory would commit as, new files included and
 * ignored ones left out. Two calls agree exactly when no tracked or new file changed,
 * which is what tells "nothing changed since the last check" without running it.
 * @param {string} dir
 */
export function workingTree(dir) {
  const tmp = path.join(os.tmpdir(), `bench-index-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const env = { ...process.env, GIT_INDEX_FILE: tmp };
  try {
    // A copy of the worktree's own index keeps its stat cache, so `add -A` hashes only the
    // files that changed rather than every file in the tree. Staged or not, the result
    // is the same: `add -A` makes the copy match the working directory.
    const own = git(dir, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
    if (fs.existsSync(own)) fs.copyFileSync(own, tmp);
    else if (revParse(dir)) git(dir, ['read-tree', 'HEAD'], { env });
    git(dir, ['add', '-A'], { env });
    return git(dir, ['write-tree'], { env });
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Files, lines added and removed, against `ref`. @param {string} dir @param {string} ref */
export function workingStat(dir, ref) {
  const out = { files: 0, added: 0, removed: 0 };
  for (const row of diffWorking(dir, ref, ['--numstat']).split('\n').filter(Boolean)) {
    const [a, r] = row.split('\t');
    out.files++;
    out.added += Number(a) || 0;
    out.removed += Number(r) || 0;
  }
  return out;
}

// -- merging --------------------------------------------------------------------

/**
 * The tree a merge of `b` into `a` would produce, without touching any checkout.
 * @param {string} dir @param {string} a @param {string} b
 */
export function mergeTree(dir, a, b) {
  try {
    return { clean: true, tree: git(dir, ['merge-tree', '--write-tree', a, b]).split('\n')[0], conflicts: /** @type {string[]} */ ([]) };
  } catch (e) {
    const lines = String(/** @type {any} */ (e).stdout || '').split('\n');
    const conflicts = [...new Set(lines.slice(1).map((l) => /^\d{6} [0-9a-f]+ \d\t(.+)$/.exec(l)?.[1]).filter(Boolean))];
    return { clean: false, tree: lines[0] || null, conflicts: /** @type {string[]} */ (conflicts) };
  }
}

/**
 * Lands `branch` on `target`. `merge` keeps the task's commits under a merge commit
 * (or fast-forwards when it can); `squash` lands them as one commit.
 *
 * Where the target is checked out somewhere, git itself does the merge there, so the
 * files on disk move with the branch and git refuses on its own if local changes would
 * be overwritten. Where it is not, the merge is written with merge-tree and
 * commit-tree, and only the ref moves.
 *
 * @param {string} repo @param {{branch:string, target:string, message:string, strategy?:'merge'|'squash'}} o
 * @returns {{commit:string, fastForward:boolean}}
 */
export function land(repo, { branch, target, message, strategy = 'merge' }) {
  const tip = revParse(repo, `refs/heads/${branch}`);
  const base = revParse(repo, `refs/heads/${target}`);
  if (!tip || !base) throw new Error(`Cannot find ${tip ? target : branch}`);
  if (isAncestor(repo, tip, base)) throw Object.assign(new Error(`${target} already contains ${branch}`), { code: 'MERGED' });
  const m = mergeTree(repo, base, tip);
  if (!m.clean) throw Object.assign(new Error(`Conflicts with ${target}: ${m.conflicts.join(', ')}`), { code: 'CONFLICT', conflicts: m.conflicts });
  const ff = strategy === 'merge' && isAncestor(repo, base, tip);
  const at = checkedOutAt(repo).get(target);
  if (at) {
    try {
      if (strategy === 'squash') {
        git(at, ['merge', '--squash', branch]);
        git(at, ['commit', '-q', '-m', message]);
      } else git(at, ['merge', ff ? '--ff-only' : '--no-ff', '--no-edit', '-m', message, branch]);
    } catch (e) {
      try {
        git(at, strategy === 'squash' ? ['reset', '--merge'] : ['merge', '--abort']);
      } catch {
        /* nothing was started */
      }
      throw Object.assign(new Error(`git refused to merge in ${at}: ${gitError(e)}`), { code: 'CHECKOUT' });
    }
    return { commit: git(at, ['rev-parse', 'HEAD']), fastForward: ff };
  }
  const commit = ff ? tip : git(repo, ['commit-tree', /** @type {string} */ (m.tree), '-p', base, ...(strategy === 'squash' ? [] : ['-p', tip]), '-m', message]);
  git(repo, ['update-ref', `refs/heads/${target}`, commit, base]);
  return { commit, fastForward: ff };
}

/**
 * Brings the target's new commits into a task's worktree. A conflict is left in the
 * worktree, where the task's session can resolve it.
 * @param {string} dir @param {string} target
 */
export function mergeInto(dir, target) {
  try {
    git(dir, ['merge', '--no-edit', target]);
    return { ok: true, conflicts: /** @type {string[]} */ ([]) };
  } catch (e) {
    const conflicts = status(dir).conflicted;
    if (conflicts.length) return { ok: false, conflicts };
    throw new Error(gitError(e));
  }
}

/** @param {string} dir */
export function abortMerge(dir) {
  git(dir, ['merge', '--abort']);
}

/** How a task's branch stands against its base. @param {string} dir the task worktree @param {string} branch @param {string} target */
export function compare(dir, branch, target) {
  const ahead = count(dir, `${target}..${branch}`);
  const behind = count(dir, `${branch}..${target}`);
  return { ahead, behind };
}

// -- GitHub -----------------------------------------------------------------------

/**
 * What a person typed for a repository, as something `git clone` takes, and the folder
 * name it clones into. `owner/repo` is GitHub shorthand; anything else is passed to git
 * as given, except a value that could be read as an option.
 * @param {string} spec @returns {{url:string, name:string, github:string|null}}
 */
export function repoSpec(spec) {
  const s = String(spec || '').trim();
  if (!s) throw new Error('Name a repository');
  if (s.startsWith('-')) throw new Error('That is not a repository');
  const short = /^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(s);
  if (short && !s.includes(':') && !s.startsWith('.') && !s.startsWith('/')) {
    return { url: `https://github.com/${short[1]}/${short[2]}.git`, name: short[2], github: `${short[1]}/${short[2]}` };
  }
  const gh = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(s);
  const name = (/([^/:]+?)(?:\.git)?\/?$/.exec(s)?.[1] || '').replace(/^\.+/, '');
  if (!name) throw new Error('Cannot tell the repository name from that');
  return { url: s, name, github: gh ? `${gh[1]}/${gh[2]}` : null };
}

/**
 * Clones into `dir`, which must not exist yet. A GitHub repository goes through `gh`
 * when it is logged in, so a private one needs no other credentials.
 * @param {{url:string, github:string|null}} spec @param {string} dir
 */
export async function clone(spec, dir) {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const viaGh = spec.github && (await ghReady());
  /** @type {[string, string[]]} */
  const [cmd, args] = viaGh && spec.github ? ['gh', ['repo', 'clone', spec.github, dir]] : ['git', ['clone', '--', spec.url, dir]];
  await new Promise((resolve, reject) =>
    execFile(cmd, args, { timeout: 15 * 60 * 1000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, _out, stderr) => {
      if (!err) return resolve(undefined);
      fs.rmSync(dir, { recursive: true, force: true });
      reject(new Error(gitError({ stderr, message: err.message }) || 'The clone failed'));
    })
  );
}

/**
 * The person's own repositories on GitHub, newest first, through `gh`. Empty when `gh`
 * is not logged in.
 * @returns {Promise<{name:string, description:string, private:boolean, updatedAt:string}[]>}
 */
export function githubRepos() {
  return new Promise((resolve) =>
    execFile('gh', ['repo', 'list', '--limit', '200', '--json', 'nameWithOwner,description,isPrivate,updatedAt'], { timeout: 30000, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
      if (err) return resolve([]);
      try {
        resolve(JSON.parse(String(out)).map((/** @type {any} */ r) => ({ name: r.nameWithOwner, description: r.description || '', private: !!r.isPrivate, updatedAt: r.updatedAt })));
      } catch {
        resolve([]);
      }
    })
  );
}

/** @returns {Promise<boolean>} */
export function ghReady() {
  return new Promise((resolve) => execFile('gh', ['auth', 'status'], { timeout: 10000 }, (err) => resolve(!err)));
}

/** @param {string} dir @param {{head:string, base:string, title:string, body:string}} o @returns {Promise<string>} */
export function createPullRequest(dir, { head, base, title, body }) {
  return new Promise((resolve, reject) =>
    execFile('gh', ['pr', 'create', '--head', head, '--base', base, '--title', title, '--body', body], { cwd: dir, timeout: 60000 }, (err, stdout, stderr) =>
      err ? reject(new Error(String(stderr || err.message).trim())) : resolve(String(stdout).trim().split('\n').pop() || '')
    )
  );
}
