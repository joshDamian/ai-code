import fs from 'node:fs';
import path from 'node:path';
import { git } from './git.mjs';

// Directories that are never worth spending prompt tokens on. `.ai-code` holds the
// database and the generated context itself, and the rest are all rebuildable.
// They are dropped at the walk, so they cost neither a prompt slot nor a line in
// the file tree.
const ignored = new Set([
  '.git', 'node_modules', '.ai-code', '.next', 'dist', 'build', 'coverage',
  '.turbo', '.cache', 'target', '.venv', 'venv', '__pycache__', '.pytest_cache',
  // Vendor and build output under the names other ecosystems use. A vendored
  // tree is the one thing that reliably out-scores real source on term
  // frequency, because it is a copy of somebody else's code.
  'vendor', 'third_party', 'bower_components', '.gradle', 'obj', 'out',
  '.svelte-kit', '.nuxt', '.output', '.parcel-cache', '.tox', 'site-packages',
  // Editor state. Measured cost of leaving it in: an IDE's project file took the
  // third slot on a task that had nothing to do with it.
  '.idea', '.vscode',
]);

// Files that are real, and stay in the tree, but never earn a prompt slot: a
// lockfile, a minified bundle, a sourcemap. Excluded from *scoring* rather than
// from the walk, because the tree is how the agent finds things and a lockfile's
// path is a true fact about the repository. What it must not do is take a slot
// from a file the task is about - which is what `package-lock.json` did, at 3009
// tokens, on a task about a form component.
const NOISE_FILE = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|Pipfile\.lock|composer\.lock|Gemfile\.lock|go\.sum|packages\.lock\.json)$|\.min\.(js|mjs|cjs|css)$|\.map$/;

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
  // §5.2's edge rule: how hard a file that already won a slot pulls on the files
  // it imports and is imported by. 0 turns the graph off, which is how the
  // harness measures it rather than asserting it - see the note on the value.
  edge: 3,
  // §5.1's def rule: how hard a task term pulls on the files that declare a name
  // containing it. 0 turns symbol retrieval off, same reason as `edge`. Measured
  // flat from 6 to 20 with the cliff at 25; 12 is the middle of that. See the note
  // on the rejected undivided variant in `declaredBy`.
  define: 12,
};

export function contextConfig(configured) {
  return { ...CONTEXT_DEFAULTS, ...(configured || {}) };
}

// The same four-characters-per-token estimate the run accounting uses, so the
// budget the assembler respects and the usage it records are measured alike.
export function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

// `unreadable` collects the directories this process could not open. A directory
// it cannot read is a fact about permissions, not about the repository, and
// dropping the whole run over one would trade a working context for a clean
// error. The walk degrades to what it could see and records what it missed, so
// the caller can say so rather than silently ranking a smaller repo.
function walk(root, rel = '', out = [], unreadable = []) {
  const dir = path.join(root, rel);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    unreadable.push(rel || '.');
    return out;
  }
  for (const e of entries) {
    if (ignored.has(e.name)) continue;
    const r = path.join(rel, e.name);
    if (e.isDirectory()) walk(root, r, out, unreadable);
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
  const unreadable = [];
  const files = walk(root, '', [], unreadable);
  // `unreadable` is additive: every existing caller reads `files` and ignores it,
  // and the manifest surfaces it so a shrunken ranking is distinguishable from a
  // small repository.
  return { language, framework, commands, files, unreadable };
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

// Split on punctuation, camelCase, acronym runs and digit boundaries, so
// `buildTaskContext` yields `build`, `task`, `context` and `HTTPServer` yields
// `http` and `server` rather than the single unsplittable `httpserver`.
//
// The third alternative is the acronym rule, and the order of the alternatives is
// load-bearing: it only fires where the camelCase rule did not, so `getUserID`
// splits at the first capital after a lowercase (`get` | `UserID`) and then, since
// `ID` has no lowercase after it, stays whole. `parseHTMLResponse` splits first at
// `H` and then at `R`, giving `parse`, `html`, `response`.
//
// The floor stays at three. Lowering it to two recovers `ui`, `db`, `io`, `js`
// and `id` - and equally admits `to`, `of`, `in`, `is`, `do` and `an`, which then
// earn the full basename weight of a real term. The floor and the inverse
// document-frequency weighting are one change because of this, and this half is
// the half that cannot ship alone; see the design note on tokenizer defects.
function tokenize(text) {
  return String(text || '')
    .split(/[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)
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

// -- the import graph -------------------------------------------------------

// Extensions worth a regex pass for imports. Anything else - a lockfile, a
// markdown doc, an asset - can name a path in prose, and an edge drawn from prose
// is a wrong edge. The set is deliberately short: a language missing from it
// contributes no edges, which costs recall, while a wrong entry costs precision on
// every task in a repository of that kind.
const SOURCE_FILE = /\.(mjs|cjs|js|jsx|ts|tsx|py|rb)$/;

// Every form that names another file. In order: an ESM re-export or import, a
// dynamic `import()`, a CommonJS `require()`, Python's `from x import y` and bare
// `import x`, and the side-effect import `import './x.mjs'` - last because it
// shares a prefix with the dynamic form and the `from` forms have to win where
// they can. The leading `(?:^|[^.\w])` keeps the ESM alternatives from firing on
// the tail of a longer word, so a comment mentioning `transform` is not a
// specifier.
const IMPORT_SPEC = /(?:^|[^.\w])from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\s*\(\s*['"]([^'"]+)['"]\s*\)|^[ \t]*from\s+([.\w]+)\s+import\b|^[ \t]*import\s+([.\w]+)|(?:^|[^.\w])import\s+['"]([^'"]+)['"]/gm;

// What a bare module name may resolve to. The empty string is first so an
// explicit extension wins over a guessed one.
const MODULE_EXT = ['', '.mjs', '.cjs', '.js', '.jsx', '.ts', '.tsx', '.py', '.rb'];

// A specifier, as the file in this tree it denotes, or null when it denotes none.
// A bare specifier is a package or a stdlib module, which is not in the tree, so
// only the dotted form Python writes for its own modules is given a second chance.
//
// Cost of being wrong here is asymmetric and that is why it errs toward resolving:
// a false positive costs one low-weight edge, and Aider's edge weights are what
// the ranking is built on, while a false negative loses an edge that the frontier
// expansion has no other way to recover.
function resolveSpecifier(from, spec, known) {
  const py = /\.py$/.test(from);
  let base;
  if (py) {
    // Python writes a relative import as leading dots rather than as a path:
    // `.helper` is the sibling module `helper` and `..util` is `util` one package
    // up, so one dot means the current directory and every further dot means a
    // parent. Read as a path this resolves `pkg/.helper`, which is nothing. The
    // branch is keyed on the importing file, not on the specifier: `./deep.mjs`
    // and `.helper` both start with a dot and mean entirely different things.
    const dots = spec.startsWith('.') ? spec.match(/^\.+/)[0].length : 0;
    const rest = (dots ? spec.replace(/^\.+/, '') : spec).split('.').filter(Boolean);
    const up = new Array(Math.max(0, dots - 1)).fill('..');
    base = path.normalize(path.join(path.dirname(from), ...up, ...rest));
  } else if (spec.startsWith('.')) {
    base = path.normalize(path.join(path.dirname(from), spec));
  } else {
    // A bare specifier in JS is a package or a builtin. Neither is in this tree.
    return null;
  }
  for (const ext of MODULE_EXT) if (known.has(base + ext)) return base + ext;
  // A directory import means its index. `__init__` is Python's spelling of the
  // same thing.
  for (const name of ['index', '__init__']) {
    for (const ext of MODULE_EXT.slice(1)) {
      const c = path.join(base, name + ext);
      if (known.has(c)) return c;
    }
  }
  return null;
}

// Which files name which others, and the reverse, in both directions.
//
// One pass over the files the walk already returned, at 648 KB of source for this
// repository - the cost §2.4 calls near-zero, and it is a regex rather than a
// parse because a false positive costs a low-weight edge, not a wrong answer.
//
// Both directions are kept because they are different signals and the frontier
// needs both: a seed's imports are the files it is built on, and its importers are
// the files built on it. Keeping only one loses half the frontier.
export function importGraph(root, files) {
  const known = new Set(files);
  const imports = new Map();
  const importedBy = new Map();
  for (const f of files) { imports.set(f, new Set()); importedBy.set(f, new Set()); }
  for (const file of files) {
    if (!SOURCE_FILE.test(file)) continue;
    const text = readText(path.join(root, file));
    // A binary file read as UTF-8 yields replacement characters, and a NUL means
    // it was never text at all.
    if (!text || text.includes('\u0000')) continue;
    for (const m of text.matchAll(IMPORT_SPEC)) {
      const spec = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
      if (!spec) continue;
      const target = resolveSpecifier(file, spec, known);
      if (!target || target === file) continue;
      imports.get(file).add(target);
      importedBy.get(target).add(file);
    }
  }
  return { imports, importedBy };
}

// The frontier: what one hop of §5.2's edge rule reaches from the files the
// lexical pass already picked, and how hard it pulls on each.
//
// The pull is `score(seed) × weight / (1 + fanout(seed))`, and both divisions are
// measured rather than assumed. Against the 22-run corpus in `ai-code eval`:
//
//  - **`×50` is worse than no graph at all.** The table's constant is an edge
//    weight in Aider's PageRank, where the mass is normalised; read as a score
//    multiplier it evicts the seeds it expands from, and the window fills with
//    one seed's neighbours. Swept over `edge`, recall peaks at 3-5 and decays
//    from 6 onward, crossing below the graph-disabled baseline by 20.
//  - **Fan-out division is not optional.** Undivided, every weight is strictly
//    worse than disabling the graph (macro recall 0.69 -> 0.54): nine of
//    `web/views/task-detail.mjs`'s imports beat the two of `src/server.mjs`
//    purely on that seed's size. This is §5.3's "a signal's weight falls as its
//    coverage rises", and §5.2's `sqrt(n)` reference-count term applied to the
//    edge's source; `1 + n` beat `1 + sqrt(n)` by 3 points of macro recall.
//
// At 3 the pull is worth about one lexical hit, which is the calibration to
// state rather than the sweep's argmax: `edge` 3 and 4 tie on recall and 3 leads
// on nDCG, and the plateau is wide enough that the exact value inside it is not
// load-bearing. Phase 5 owns the real calibration; this is a defensible default
// with the measurement recorded, not a tuned constant.
//
// The pull is a max over seeds, not a sum, which is deliberate: summing makes a
// file's rank a function of its degree, and the file imported by nine seeds wins
// for being popular rather than for being relevant - the exact failure §5.2's
// `1/(1+df)` term exists to prevent on the lexical side.
//
// Deterministic: the max is over a Set, but only the pull is kept, so the order
// two equal pulls are discovered in cannot reach the output.
function frontier(seeds, scores, graph, weight) {
  const pull = new Map();
  for (const seed of seeds) {
    const strength = scores.get(seed) || 0;
    const neighbours = new Set([...(graph.imports.get(seed) || []), ...(graph.importedBy.get(seed) || [])]);
    if (!neighbours.size) continue;
    const scale = (strength * weight) / (1 + neighbours.size);
    for (const n of neighbours) pull.set(n, Math.max(pull.get(n) || 0, scale));
  }
  return pull;
}

// -- declarations -----------------------------------------------------------

// The forms that name a thing a task can ask for, one per family: `function`/
// `const`/`class`/`interface`/`type` for JS and TS, `def`/`class` for Python and
// Ruby. §5.1 also names Rust's `struct` and `impl`, and those are not here because
// `SOURCE_FILE` carries no `.rs` - a pattern on a language no repository can hand
// this function is a pattern nothing tests. The Python and Ruby forms are carried
// on the opposite argument: `.py` and `.rb` *are* in `SOURCE_FILE`, so they fire on
// another repository. This tree holds neither, which makes them untested here
// rather than dead.
//
// Column 0 is the filter that does the work. A `const` inside a function body is
// a local binding, not the API the task names, and counting them inflates every
// common word's fan-out: `input` resolved to two files instead of one and `task`
// to thirteen instead of seven, on `const input = usage.inputTokens` and
// `const task = await store.task(id)`. Aider gets this from tree-sitter's
// `is_important` scope filter; at this size, requiring the match to start the line
// separates the two: top-level-only reproduces §2.4's table (`input` 1, `field` 1,
// `description` 0) where the unrestricted extractor does not. A false positive
// costs a low-weight edge, not a wrong answer.
const DECLARATION = [
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm,
  /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm,
  /^(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm,
  /^(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm,
  /^(?:async\s+)?def\s+([A-Za-z_]\w*)/gm,
  /^class\s+([A-Za-z_]\w*)/gm,
];

// Which files declare a name, keyed both by the identifier and by each of its
// sub-tokens. This is a second pass over the source files, not a share of
// `importGraph`'s: measured at 8.8 ms against the graph's 7.0 ms, and 15.1 ms for
// the pair inside a 45.8 ms `relevantFiles`. It is the cheapest signal in the
// ranker after the path, but it is not free, and the reads are where its cost
// sits rather than the regexes.
//
// The key is the sub-token because that is what a task text produces: a task says
// "input", never `TextInput`. §5.1 also asks for the whole identifier to be
// emitted alongside its sub-tokens, on both sides, and that half was built and
// then removed: keyed here and on the query, it moved the summary by 0.000000 on
// all four metrics, because `tokenize` splits camelCase before either side sees
// it - so the only whole multi-word forms a task text contains are words like
// `PLAN`, whose lowercase form is already a sub-token. The sub-token key is the
// whole mechanism.
export function declarations(root, files) {
  const defines = new Map();
  for (const file of files) {
    if (!SOURCE_FILE.test(file)) continue;
    const text = readText(path.join(root, file));
    if (!text || text.includes('\u0000')) continue;
    const names = new Set();
    for (const re of DECLARATION) {
      // `matchAll` clones the regex and copies `lastIndex`, so a shared global
      // pattern is safe only while nothing leaves it advanced. Resetting says so
      // rather than relying on it.
      re.lastIndex = 0;
      for (const m of text.matchAll(re)) names.add(m[1]);
    }
    for (const name of names) {
      for (const key of new Set(tokenize(name))) {
        if (!defines.has(key)) defines.set(key, new Set());
        defines.get(key).add(file);
      }
    }
  }
  return defines;
}

// What the task's own words pull in, as a path -> weight map. The query token is
// the key and the declaring file is the target, which is the direction the import
// graph cannot go: an edge there runs from a file that already won a slot, and a
// task naming a symbol the tree was never ranked against has no such file.
//
// §5.3's self-normalising rule, in the one place it is load-bearing: the weight
// falls with the number of files declaring the name, so vocabulary shared across
// the tree cannot outvote a symbol that appears once. §5.2's flat `>5 files ->
// x0.1` demotion was replaced by this continuous fall - it is the same rule with
// the threshold taken out.
function declaredBy(tokens, defines, weight) {
  const pull = new Map();
  // Sorted, not in Set order: the accumulation is a float sum, and a sum whose
  // order depends on how the task text happened to tokenize is a sum that can
  // differ in the last bits between two runs of the same task.
  for (const token of [...tokens].sort()) {
    const files = defines.get(token);
    if (!files || !files.size) continue;
    // §5.2's `sqrt(n)` term, at the scale of the corpus rather than of one file:
    // the pull a name generates is divided across the files declaring it. `sqrt`
    // and not `n`, because a name eleven files declare and one a single file
    // declares differ by about 3x on the evidence rather than 11x - the count is a
    // weak proxy for how common the name is and should not speak with a strong
    // voice.
    //
    // **Undivided measured higher and was rejected anyway.** With no divisor at
    // all the macro recall is 0.873 against 0.855 here, every metric better and a
    // wider leave-one-out margin - and on a task whose tokens are all common
    // vocabulary it fills all fifteen slots with files that merely declare those
    // words, returning zero relevant files out of 22 gold. Measured on the Mission
    // Control runs: 0.182, 0.250 and 0.211 become 0.000, where this divisor leaves
    // them at 0.045, 0.063 and 0.053. A ranker that can hand back an empty-relevant
    // window has failed in a way recall@15 averaged over a corpus cannot express,
    // and one constant buys its absence back. §5.3's rule is what does it: a signal
    // whose weight does not fall with its coverage is a signal that will drown the
    // window on the queries where coverage is all it has.
    const w = weight / Math.sqrt(files.size);
    for (const file of files) pull.set(file, (pull.get(file) || 0) + w);
  }
  return pull;
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

  // Lockfiles and bundles stay in the tree but never earn a slot. Filtered here
  // rather than at the walk so the tree still lists them.
  const rankable = files.filter((f) => !NOISE_FILE.test(f));

  const scored = rankable.map((file) => ({ path: file, score: scoreFile(file, tokens, recentRank) })).filter((f) => f.score > 0);
  // Ties break on the raw code-point order of the path, not `localeCompare`. The
  // locale-aware comparison is ICU-dependent: it orders `_`, `-` and case
  // differently under different locales, so the same repo produced different
  // contexts on two machines - which breaks the cache and the reproducibility the
  // ranking is supposed to have. Nearly every score here is a tie, so this is not
  // a cosmetic difference.
  const byPath = (a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  scored.sort(byPath);

  // The task names a symbol; the file that declares it is the file the task is
  // about. Runs before the graph pass for the reason §5.1 gives: a file the graph
  // could reach but had no seed for is reachable now, because this pass supplies
  // the seed. The defining file enters the list above the edge pass, so it is
  // within `seeds` and its own imports are followed.
  if (cfg.define > 0) {
    const entry = new Map(scored.map((f) => [f.path, f]));
    const defines = declarations(root, rankable);
    for (const [p, add] of declaredBy(tokens, defines, cfg.define)) {
      const hit = entry.get(p);
      // `define` marks a score that came from a declaration rather than from the
      // path, for the same reason `graph` does: it is the first thing a reader of
      // this list will ask about.
      if (hit) hit.score += add;
      else scored.push({ path: p, score: add, define: true });
    }
    scored.sort(byPath);
  }

  // One hop out from the files the lexical pass picked, which is where the seven
  // named misses in §2.4 live: they score nothing lexically - `src/service.mjs`
  // shares no token with the task - while every one of them is named by a file
  // that already won a slot. A file the frontier introduces starts from 0 and is
  // carried entirely by the pull, which is the point: it has no lexical evidence
  // to be ranked on.
  if (cfg.edge > 0 && scored.length) {
    const entry = new Map(scored.map((f) => [f.path, f]));
    const strength = new Map(scored.map((f) => [f.path, f.score]));
    const seeds = scored.slice(0, limit).map((f) => f.path);
    const pull = frontier(seeds, strength, importGraph(root, rankable), cfg.edge);
    for (const [p, add] of pull) {
      const hit = entry.get(p);
      // A neighbour already in the list keeps its own lexical score and gains the
      // pull on top; one the lexical pass never scored enters on the pull alone.
      // `graph` marks which, because a score that appears from nowhere is the
      // first thing a reader of this output will ask about.
      if (hit) hit.score += add;
      else scored.push({ path: p, score: add, graph: true });
    }
    scored.sort(byPath);
  }

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
  let review = role === 'repair' || role === 'reviewer' ? task.review || null : null;
  let previous = role === 'planner' ? null : previousSummary(options.store, task, role);

  const files = [...picked.contents];
  let arch = architecture;
  let conv = conventions;
  // The tree is capped up front, and the selected files are always in it: a path
  // the ranking picked is exactly the one the agent must be told about.
  const scanned = inspect(root);
  const full = scanned.files;
  const unreadable = scanned.unreadable || [];
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
  // Past this point every rung is unconditional, because the ladder above has two
  // floors it cannot pass: it never pops the last file, and the tree always keeps
  // the paths the ranking picked. So a context with one enormous file - or one
  // enormous review - left the assembler over budget and sent it anyway, which is
  // the single outcome a budget exists to prevent. A budget that can be exceeded
  // is not a budget.
  //
  // The prior attempt goes first: it is a retry signal, not the work. The review
  // is what a repair run is acting on, so it outranks the file bodies it would
  // otherwise compete with.
  while (total > cfg.budget && previous) {
    previous = null;
    trimmed.push('previous-run');
    total = size();
  }
  while (total > cfg.budget && review) {
    review = null;
    trimmed.push('review');
    total = size();
  }
  // Content to path only. The agent still learns the file exists and is still told
  // its name, which is the minimum useful form of a context; it is also what
  // `readForPrompt` already does for a binary or an unreadable file.
  if (total > cfg.budget) {
    for (const f of files) {
      if (f.text === null) continue;
      f.text = null;
      trimmed.push(`${f.path} → path only`);
    }
    total = size();
  }
  // The absolute floor. Geometric rather than one path at a time: each pass
  // multiplies the listing by `budget / total` < 1, so it reaches empty in
  // O(log n) re-measurements instead of O(n) full re-serialisations.
  if (total > cfg.budget && tree.length) {
    while (total > cfg.budget && tree.length > 0) {
      const next = Math.min(tree.length - 1, Math.floor(tree.length * (cfg.budget / total)));
      tree = tree.slice(0, Math.max(0, next));
      total = size();
    }
    trimmed.push(`tree → ${tree.length} files`);
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
    // Present only when the walk was blocked somewhere, so the common case stays
    // byte-identical to what it was: a ranking that saw less than the whole
    // repository has to be distinguishable from a small repository, or the
    // degradation is invisible to every consumer downstream.
    ...(unreadable.length ? { unreadable } : {}),
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
