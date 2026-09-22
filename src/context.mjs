import fs from 'node:fs';
import path from 'node:path';
import { git } from './git.mjs';

// Directories that are never worth spending prompt tokens on. `.ai-code` holds the
// database and the generated context itself, and the rest are all rebuildable.
const ignored = new Set(['.git', 'node_modules', '.ai-code', '.next', 'dist', 'build', 'coverage', '.turbo', '.cache', 'target', '.venv', 'venv', '__pycache__', '.pytest_cache']);

// The prompt budget and the caps that keep it bounded. Every value is overridable
// from the `context` block in routing.json.
export const CONTEXT_DEFAULTS = {
  // Total tokens the assembled context may cost.
  budget: 50000,
  // How many files are read in full. The file *list* is always included.
  files: 15,
  // Per-file character cap, so one large file cannot consume the whole budget.
  fileChars: 12000,
  // Paths listed in full. A tree is how the agent finds what the ranking did not
  // pick, but it is not free, and it grows with the repo rather than the task.
  tree: 400,
  // Character caps for the two generated documents.
  architecture: 8000,
  conventions: 4000,
};

export function contextConfig(configured) {
  return { ...CONTEXT_DEFAULTS, ...(configured || {}) };
}

// The same four-characters-per-token estimate the run accounting uses, so the
// budget the assembler respects and the usage it records are measured alike.
export function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

function walk(root, rel = '', out = []) {
  const dir = path.join(root, rel);
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignored.has(e.name)) continue;
    const r = path.join(rel, e.name);
    if (e.isDirectory()) walk(root, r, out);
    else out.push(r);
  }
  // Sorted, because readdir order is filesystem-dependent: the same repo must
  // assemble the same context on two machines.
  return out.sort();
}

export function inspect(root) {
  let language = 'unknown';
  let framework = 'unknown';
  let commands = {};
  const pkg = path.join(root, 'package.json');
  if (fs.existsSync(pkg)) {
    try {
      const p = JSON.parse(fs.readFileSync(pkg, 'utf8'));
      const d = { ...(p.dependencies || {}), ...(p.devDependencies || {}) };
      language = 'javascript/typescript';
      if (d.next) framework = 'next.js';
      else if (d.react) framework = 'react';
      else if (d.express) framework = 'express';
      commands = p.scripts || {};
    } catch {
      // An unparseable package.json leaves the defaults in place.
    }
  }
  // Checked in order, so a polyglot repo reports its most specific manifest.
  if (fs.existsSync(path.join(root, 'pyproject.toml'))) language = 'python';
  if (fs.existsSync(path.join(root, 'go.mod'))) language = 'go';
  if (fs.existsSync(path.join(root, 'Cargo.toml'))) language = 'rust';
  return { language, framework, commands, files: walk(root) };
}

// -- dependencies -----------------------------------------------------------
// Hand-rolled manifest readers. A dependency list is a handful of names and
// versions, which does not justify a parser dependency; a manifest that cannot be
// read is skipped rather than failing the command that asked for it.

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function readJson(file) {
  const text = readText(file);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Everything between `[section]` and the next section header, as raw lines.
function tomlSection(text, section) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim() === `[${section}]`);
  if (start === -1) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^\s*\[/.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

// `name = "version"` and `name = { version = "…" }` both reduce to name + version.
function tomlEntries(lines) {
  const out = [];
  for (const line of lines) {
    const m = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!m) continue;
    const version = m[2].match(/version\s*=\s*"([^"]*)"/) || m[2].match(/^"([^"]*)"/);
    out.push([m[1], version ? version[1] : null]);
  }
  return out;
}

// `flask>=2.0` / `flask[async]>=2.0` -> flask, >=2.0. Options and markers dropped.
function requirementLine(line) {
  const bare = line.split('#')[0].trim();
  if (!bare || bare.startsWith('-')) return null;
  const m = bare.match(/^([A-Za-z0-9_.-]+)\s*(?:\[[^\]]*\])?\s*(.*)$/);
  return m ? [m[1], m[2].trim() || null] : null;
}

export function readDependencies(root) {
  const out = [];
  const add = (name, version, dev, ecosystem) => out.push({ name, version: version || null, dev: !!dev, ecosystem });

  // Grouped explicitly rather than inferred: a dev dependency read as a runtime
  // one is a wrong fact in the prompt, which is worse than a missing one.
  const pkg = readJson(path.join(root, 'package.json'));
  for (const [group, dev] of [['dependencies', false], ['devDependencies', true], ['peerDependencies', false], ['optionalDependencies', false]]) {
    for (const [name, version] of Object.entries(pkg?.[group] || {})) add(name, version, dev, 'node');
  }

  const pyproject = readText(path.join(root, 'pyproject.toml'));
  if (pyproject) {
    // PEP 621, an inline array under [project], then Poetry's table.
    const inline = pyproject.match(/^\s*dependencies\s*=\s*\[([\s\S]*?)\]/m);
    if (inline) {
      for (const part of inline[1].split(',')) {
        const entry = requirementLine(part.replace(/["']/g, ''));
        if (entry) add(entry[0], entry[1], false, 'python');
      }
    }
    for (const [name, version] of tomlEntries(tomlSection(pyproject, 'project.optional-dependencies'))) add(name, version, true, 'python');
    for (const [name, version] of tomlEntries(tomlSection(pyproject, 'tool.poetry.dependencies'))) {
      if (name.toLowerCase() !== 'python') add(name, version === null ? null : String(version), false, 'python');
    }
    for (const [name, version] of tomlEntries(tomlSection(pyproject, 'tool.poetry.group.dev.dependencies'))) add(name, version, true, 'python');
  }

  for (const file of ['requirements.txt', 'requirements-dev.txt']) {
    const text = readText(path.join(root, file));
    if (!text) continue;
    for (const line of text.split('\n')) {
      const entry = requirementLine(line);
      if (entry) add(entry[0], entry[1], file.includes('dev'), 'python');
    }
  }

  const gomod = readText(path.join(root, 'go.mod'));
  if (gomod) {
    for (const line of gomod.split('\n')) {
      // Both the single-line `require x v1` and the entries of a `require (…)` block.
      const m = line.trim().match(/^(?:require\s+)?([^\s(]+)\s+v?([0-9][^\s/]*)/);
      if (m && !line.trim().startsWith('//')) add(m[1], m[2], /\/\/ indirect/.test(line), 'go');
    }
  }

  const cargo = readText(path.join(root, 'Cargo.toml'));
  if (cargo) {
    for (const [name, version] of tomlEntries(tomlSection(cargo, 'dependencies'))) add(name, version, false, 'rust');
    for (const [name, version] of tomlEntries(tomlSection(cargo, 'dev-dependencies'))) add(name, version, true, 'rust');
  }

  // A name can appear in two manifests of a polyglot repo; the ecosystem is what
  // makes it unique, so both are kept.
  const seen = new Set();
  return out.filter((d) => {
    const key = `${d.ecosystem}:${d.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// -- relevance --------------------------------------------------------------

// Entry points and configuration are included whatever the task says, because a
// change usually has to be wired in somewhere neither the title nor the plan names.
const ENTRY_POINT = /^(index|main|app|server|cli|mod|__init__)\.[a-z]+$/;
const TEST_FILE = /(^|\/)(tests?|spec|__tests__)\/|[._-](test|spec)\.[a-z]+$/;
const CONFIG_FILE = /^(package\.json|pyproject\.toml|go\.mod|Cargo\.toml|tsconfig\.json|Makefile|Dockerfile|\.env\.example)$|^\.?[a-z-]*rc(\.[a-z]+)?$/;

// Split on punctuation and camelCase so `buildTaskContext` yields `build`, `task`,
// `context`. Tokens under three characters are dropped as noise.
function tokenize(text) {
  return String(text || '')
    .split(/[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])/)
    .flatMap((t) => t.split(/(?<=[a-z])(?=[0-9])/))
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 3);
}

// The files git touched most recently, most recent first. One call for the whole
// list; a repo with no history simply contributes nothing.
function recentFiles(root) {
  try {
    return [...new Set(git(root, ['log', '--name-only', '--pretty=format:', '-n', '200']).split('\n').filter(Boolean))].map((p) => p.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function scoreFile(file, tokens, recentRank) {
  const base = path.basename(file);
  const stem = base.replace(/\.[^.]+$/, '');
  const dir = path.dirname(file);
  let score = 0;
  // A basename hit is the strongest signal available without reading the file: the
  // task named the thing, and this file is called that.
  for (const t of tokenize(stem)) if (tokens.has(t)) score += 10;
  for (const t of tokenize(dir)) if (tokens.has(t)) score += 4;
  if (ENTRY_POINT.test(base)) score += 3;
  if (CONFIG_FILE.test(base)) score += 1;
  const rank = recentRank.get(file);
  if (rank !== undefined) score += rank < 20 ? 5 : rank < 60 ? 3 : 1;
  return score;
}

// Paths whose stem matches a selected source's stem - the test for a file that was
// picked up on recency or entry-point alone.
function testSiblings(files, selected) {
  const stems = new Set(selected.map((f) => path.basename(f).replace(/\.[^.]+$/, '').replace(/\.(test|spec)$/, '')));
  return files.filter((f) => TEST_FILE.test(f) && stems.has(path.basename(f).replace(/\.[^.]+$/, '').replace(/\.(test|spec)$/, '')));
}

// Reads a file, truncated to the per-file cap. Binary-looking and oversized files
// are represented by their path alone rather than by a wall of noise.
function readForPrompt(root, file, maxChars) {
  try {
    const stat = fs.statSync(path.join(root, file));
    if (stat.size > 2 * 1024 * 1024) return null;
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    if (text.includes('\u0000')) return null;
    return text.length > maxChars ? `${text.slice(0, maxChars)}\n… (truncated, ${text.length} chars total)` : text;
  } catch {
    return null;
  }
}

// Ranks every file in the tree against the task and returns the best few, with
// their contents. Deterministic: no model is consulted, and the same task against
// the same tree always produces the same list.
export function relevantFiles(project, task, options = {}) {
  const cfg = contextConfig(options.config);
  const root = options.cwd || project.path;
  const limit = options.limit ?? cfg.files;
  const files = inspect(root).files;
  const tokens = new Set(tokenize(`${task.title || ''} ${task.description || ''} ${task.plan || ''}`));
  const recent = options.recent ?? recentFiles(root);
  const recentRank = new Map(recent.map((p, i) => [p, i]));

  const scored = files.map((file) => ({ path: file, score: scoreFile(file, tokens, recentRank) })).filter((f) => f.score > 0);
  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

  const selected = scored.slice(0, limit).map((f) => f.path);
  // Second pass, so a test file is picked up for the source it covers even when
  // the task never named it.
  for (const sibling of testSiblings(files, selected)) {
    if (!selected.includes(sibling) && selected.length < limit + 5) selected.push(sibling);
  }

  const contents = [];
  for (const file of selected) {
    const text = readForPrompt(root, file, cfg.fileChars);
    if (text !== null) contents.push({ path: file, text, tokens: estimateTokens(text) });
  }
  return { paths: selected, contents, scores: scored };
}

// -- assembly ---------------------------------------------------------------

function readDoc(projectPath, name, maxChars) {
  const text = readText(path.join(projectPath, '.ai-code', 'context', name));
  if (!text) return null;
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n… (truncated)` : text;
}

// What the previous attempt at this role left behind, so a retry does not repeat
// the failure it already hit.
function previousSummary(store, task, role) {
  if (!store) return null;
  try {
    const prior = store.listRuns(task.id).filter((r) => r.role === role && r.status !== 'running').pop();
    if (!prior) return null;
    return { status: prior.status, error: prior.error || null, model: prior.model_id || null, at: prior.ended_at || null };
  } catch {
    return null;
  }
}

// Assembles the prompt context for one role.
//
// `cwd` is the tree the agent will actually run in: the worktree for implementer,
// reviewer and repair, and the project root for the planner. Reading the project
// root for a worktree run hands the agent a file list that does not match its own
// checkout, which is why this is a parameter rather than a lookup.
export function buildTaskContext(project, task, options = {}) {
  const cfg = contextConfig(options.config);
  const role = options.role || 'planner';
  const root = options.cwd || project.path;

  const picked = relevantFiles(project, task, { ...options, cwd: root, config: cfg });

  // Sections in the order the spec fixes: what the project is, the files that
  // matter, the approved plan, then whatever the last attempt in this role left.
  const architecture = readDoc(project.path, 'architecture.md', cfg.architecture);
  const conventions = readDoc(project.path, 'conventions.md', cfg.conventions);
  const review = role === 'repair' || role === 'reviewer' ? task.review || null : null;
  const previous = role === 'planner' ? null : previousSummary(options.store, task, role);

  const files = [...picked.contents];
  let arch = architecture;
  let conv = conventions;
  // The tree is capped up front, and the selected files are always in it: a path
  // the ranking picked is exactly the one the agent must be told about.
  const full = inspect(root).files;
  let tree = [...new Set([...picked.paths, ...full])].slice(0, cfg.tree);
  const size = () => estimateTokens(JSON.stringify({ tree, architecture: arch, conventions: conv, files, review, previous }));
  let total = size();

  // Trim order: the lowest-ranked file first, because it scored lowest against the
  // task; then the generated docs, which are background rather than the thing being
  // worked on; and last the tree, down to only the files actually shown. Each pass
  // re-measures, since the per-section caps bound each section but only the total
  // is compared against the budget.
  const trimmed = [];
  while (total > cfg.budget && files.length > 1) {
    trimmed.push(files.pop().path);
    total = size();
  }
  while (total > cfg.budget && conv) {
    conv = null;
    trimmed.push('conventions.md');
    total = size();
  }
  while (total > cfg.budget && arch) {
    arch = null;
    trimmed.push('architecture.md');
    total = size();
  }
  if (total > cfg.budget && tree.length > picked.paths.length) {
    tree = [...new Set([...picked.paths, ...files.map((f) => f.path)])];
    trimmed.push(`tree → ${tree.length} files`);
    total = size();
  }

  const manifest = {
    files: files.map((f) => ({ path: f.path, tokens: f.tokens })),
    // The file list is cheap and is what tells the agent where things live.
    tree: tree.length,
    sections: [arch && 'architecture', conv && 'conventions', task.plan && 'plan', review && 'review', previous && 'previous-run'].filter(Boolean),
    tokens: total,
    budget: cfg.budget,
    trimmed,
    cwd: root,
  };

  return {
    project: { id: project.id, name: project.name, path: root, language: project.language, framework: project.framework, commands: project.commands },
    task: { id: task.id, title: task.title, plan: task.plan },
    tree,
    architecture: arch,
    conventions: conv,
    files,
    review,
    previous,
    manifest,
  };
}

// Writes the deterministic, LLM-free context files that `context init` produces.
export function writeContext(project) {
  const info = inspect(project.path);
  const dir = path.join(project.path, '.ai-code', 'context');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ name: project.name, path: project.path, language: info.language, framework: info.framework }, null, 2));
  fs.writeFileSync(path.join(dir, 'structure.json'), JSON.stringify(info.files.slice(0, 500), null, 2));
  fs.writeFileSync(path.join(dir, 'commands.json'), JSON.stringify(info.commands, null, 2));
  fs.writeFileSync(path.join(dir, 'dependencies.json'), JSON.stringify(readDependencies(project.path), null, 2));
  return info;
}
