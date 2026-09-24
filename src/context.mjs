import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
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
  // Per-file character cap, so one large file cannot consume the whole budget. It
  // is also §5.5's render threshold and the surface's own cap, which is deliberate:
  // a file at or under it is inlined whole, a larger source file is rendered as its
  // surface within the same cap, and anything else is cut to its first `fileChars`.
  // So the render cannot make a file cost more than it did before - it is the same
  // number of characters spent on better ones.
  fileChars: 12000,
  // Paths listed in full. A tree is how the agent finds what the ranking did not
  // pick, but it is not free, and it grows with the repo rather than the task.
  tree: 400,
  // Character caps for the two generated documents.
  architecture: 8000,
  conventions: 4000,
  // §5.3 step 2: the tokenizer's minimum length. 3 is the pre-phase-5 value; 2 is
  // the design's. It ships at 2 only because `dfHalf` ships above it: with the
  // weight off, dropping the floor measured 0.8181 macro against 0.8551, and with
  // it on the two settings are identical to six decimals and rank 22 of 22 harness
  // runs the same. See the note in §5.3 - the two are one change.
  floor: 2,
  // §5.3 step 3: the shape of the token weight, `half/(half + df)`. `half = 1` is
  // the design's exact `1/(1+df)`. 0 disables the weighting, which is the
  // pre-phase-5 behaviour.
  dfHalf: 1,
  // §5.3 step 3, the amplitude. The doc's formula is relative to `df = 0`, but a
  // token that appears in a path has `df >= 1` by construction, so the design's
  // shape puts the *strongest possible* path hit at half its phase-4 value (0.5 at
  // `half = 1`) while the priors - entry point, config, recency - keep theirs.
  //
  // Swept as its own axis, against `edge` and `define`, and left at 1. Raising it
  // raises the headline: `gain` 5 to 8 reads as 0.8805 macro against 0.8435. That
  // headline is over the nine runs whose gold does not exceed the window; the five
  // runs the window *does* bind - 16 to 27 gold, 89 of the corpus's unoffered
  // files - get worse at every one of those gains (18% to 9% recall on one of
  // them), and MRR and nDCG, which take every run, both fall. `gain` 9 and above
  // collapses outright, the same way phase 4's undivided fan-out did when one
  // signal was allowed to dominate. 1 keeps the doc's formula as written.
  gain: 1,
  // §5.2's edge rule: how hard a file that already won a slot pulls on the files
  // it imports and is imported by. 0 turns the graph off, which is how the
  // harness measures it rather than asserting it - see the note on the value.
  // Phase 4 shipped 3 against path hits of 10. `dfHalf` rescales those, so the
  // value was re-swept with it: at the old 3 the pull is too strong for the smaller
  // lexical scores it now competes with, and 2 beats it on micro recall (0.7636 to
  // 0.7273), nDCG (0.6454 to 0.6038) and unoffered (13 to 15) while losing macro
  // (0.8435 to 0.8551). Macro is the one metric a single 3-file run swings a third
  // of a point, and that run is the only one 3 wins.
  edge: 2,
  // §5.1's def rule: how hard a task term pulls on the files that declare a name
  // containing it. 0 turns symbol retrieval off, same reason as `edge`. Measured
  // rising to a plateau: 6 reads 0.8181 macro against 12's 0.8805, and 12, 16 and
  // 20 are identical to four decimals, so 12 is the foot of the plateau rather than
  // its middle. See the note on the rejected undivided variant in `declaredBy`.
  define: 12,
  // §5.1's PageRank over the symbol graph was built and measured in phase 8 and
  // removed: see §9. It is not a default of 0, it is absent, because a knob nobody
  // re-measures is the failure mode phase 7 named.
  // §5.5: how much of a task-named declaration's body a surface carries, in
  // characters, and how much of the cap is held back from the listing so that body
  // survives. A task that names three symbols in one file is a task about the file,
  // so this is deliberately most of a small one.
  matchedChars: 2000,
  // §5.14: how many names the ranker may offer beyond the window. Swept as
  // {1,2,3,4,5,8} in one process against one tree: `tailShare` - the share of the
  // answers the window missed that the tail names at all - reads 0.32, 0.56, 0.74,
  // 0.82, and the last two are identical to the digit. 4 is the value that keeps
  // the last increment inside §5.14's own range while still naming 65 of 88 misses;
  // 5 buys 7 more for the worst marginal rate in the table (85 tokens a hit against
  // 54 at 4). 1 is the reversal key and makes `tail` empty on every run.
  widen: 4,
  // §5.14 asks for the wider list "for a task with little lexical signal", and
  // `state` is that condition expressed where the ranker can read it - `NO_RESULTS`
  // and `DEGRADED`. It is measured at **zero**: no harness run is in either state,
  // so the state-keyed arm produces no tail on any of the 14, and the whole effect
  // comes from `always`. It ships at `always` for that reason, and the key is kept
  // rather than deleted because it is the trigger the design names and the claim
  // that it does nothing here is worth being able to re-run on a larger corpus.
  widenOn: 'always',
  // §5.10's record. Off by default: it is a few KB per run and nothing in the
  // prompt path reads it.
  debug: false,
  // §5.6: the share of the routed model's window a request may occupy. The
  // remainder is the model's own output, which is why the number is not 1 - the
  // same 0.85 the service's post-assembly guard uses, so the budget and the guard
  // cannot disagree about where the line is.
  windowShare: 0.85,
  // The floor under the derived budget. Without it a small window can make the
  // formula negative, and the ladder below would then be asked to fit a context
  // into less than nothing. 200 tokens is the smallest number that still holds the
  // empty skeleton the last rung reduces to.
  minBudget: 200,
};

export function contextConfig(configured) {
  return { ...CONTEXT_DEFAULTS, ...(configured || {}) };
}

// §5.6's budget derivation. The window is the routed model's context length and
// `fixed` is everything the request carries outside the context JSON - the role
// prompt, the task text, the approved plan, the harness preamble. Those are
// measured by the caller because only it knows them, and measured rather than
// guessed because they are not small: the planner prompt alone is a couple of
// thousand tokens.
//
// The doc writes the formula with a separate `reserve_output` term as well as the
// 0.85. That is a double count - the share already leaves the output room - so the
// share is the output reserve and there is no second term. §9 records the
// departure.
export function windowBudget(window, fixed, cfg = CONTEXT_DEFAULTS) {
  if (!window || !Number.isFinite(window)) return cfg.budget;
  const usable = Math.floor(window * cfg.windowShare) - Math.max(0, Math.floor(fixed || 0));
  return Math.max(cfg.minBudget, Math.min(cfg.budget, usable));
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
function tokenize(text, min = 3) {
  return String(text || '')
    .split(/[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)
    .flatMap((t) => t.split(/(?<=[a-z])(?=[0-9])/))
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= min);
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

// How many paths contain each token, which is §5.3's df over the path list
// `inspect(root)` already returns. One tokenize per path, so the whole table costs
// one pass over the tree.
function pathDocFreq(files, floor) {
  const df = new Map();
  for (const file of files) {
    for (const t of new Set(tokenize(file, floor))) df.set(t, (df.get(t) || 0) + 1);
  }
  return df;
}

// Lucene's strictly-positive IDF over the same path document frequency. Strictly
// positive matters (§5.3 step 4): an IDF that turns negative past `df = N/2` would
// need flooring and would invert the weight of a common token, which is worse than
// merely damping it.
function idf(df, n) {
  return Math.log(1 + (n - df + 0.5) / (df + 0.5));
}

// The tokens a file's path contributes to the lexical score. `scoreFile` tokenizes
// the stem and the directory separately because it weights them 10 and 4; the
// *membership* is the union, and it is the union §5.7's per-file coverage
// quantities are defined over. Derived from the path alone, so it costs nothing
// and, unlike §6.3's removed content index, re-reads nothing.
function pathTokens(file, floor) {
  const base = path.basename(file);
  const stem = base.replace(/\.[^.]+$/, '');
  return new Set([...tokenize(stem, floor), ...tokenize(path.dirname(file), floor)]);
}

// §5.7's attainable-score ceiling, restricted to the in-vocabulary terms. The
// restriction is load-bearing and §5.7 says why: an out-of-vocabulary term scores
// the *largest* idf in the collection under this formula, so counting the absent
// terms would crush every score by more than the present ones contribute. Terms
// with `df = 0` over the paths are exactly the terms this repository cannot answer.
function ceilQuery(tokens, df, n) {
  let ceil = 0;
  let coverage = 0;
  for (const t of [...tokens].sort()) {
    const d = df.get(t) || 0;
    if (d > 0) {
      ceil += idf(d, n);
      coverage += 1;
    }
  }
  return { ceil, coverage };
}

// §5.7's dispersion predictor. `k = 100` is the paper's value and the doc's; this
// corpus has fewer than 100 candidates, so `k` is effectively "all of them" here
// and the constant is kept for the larger repos the formula is for.
function nqc(scores, k = 100) {
  const top = scores.slice(0, k);
  if (!top.length || !top[0]) return 0;
  const mean = top.reduce((a, b) => a + b, 0) / top.length;
  const variance = top.reduce((a, b) => a + (b - mean) ** 2, 0) / top.length;
  return Math.sqrt(variance) / top[0];
}

// §5.7's `QUERY_IDF_FLOOR` is a percentile of the per-term idf distribution rather
// than a constant, because the same floor is wrong at every corpus size. The doc
// names the shape - "the idf of a term with `df = 0.3N`" - and this is that value
// computed from the actual `N`, so it travels with the repository.
function idfFloor(n) {
  return idf(Math.max(1, Math.round(0.3 * n)), n);
}

// A short, stable digest for the debug record. `JSON.stringify` over an object with
// insertion-ordered keys is deterministic in V8 for string keys, and the config is
// spread from `CONTEXT_DEFAULTS` in a fixed order, so this is stable across runs on
// one machine - which is what it is for.
function digest(value) {
  return createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 12);
}

// A hash of the tree's *contents* rather than its paths. `treeHash` says the file
// list is unchanged; §5.12 item 5 is the measurement that says that is not the same
// claim - renaming one function moved macro recall 3.7 points through the `define`
// index with every path in the tree identical. So "same tree" was a discipline the
// harness asked for and could not check, and it is checked here instead.
//
// Every figure the harness produces is a property of (ranker, tree), and until this
// existed the second argument was unverifiable from a record. Hashing shares the
// call's source cache, so the text is read once for all four passes and this costs
// the sha1s rather than another 648 KB.
function contentDigest(root, files, cache) {
  const pairs = [];
  for (const f of files) {
    if (!SOURCE_FILE.test(f)) continue;
    const text = sourceText(root, f, cache);
    if (!text || text.includes('\u0000')) continue;
    pairs.push([f, createHash('sha1').update(text).digest('hex')]);
  }
  return digest(pairs);
}

// Returns the score and, when `parts` is asked for, the per-signal breakdown the
// debug record (§5.10) persists. The breakdown is built unconditionally - it is
// four numbers - and only the assembling of it is skipped, so a normal run pays a
// couple of object literals per file rather than a second scoring pass.
function scoreFile(file, tokens, recentRank, ctx = {}) {
  const base = path.basename(file);
  const stem = base.replace(/\.[^.]+$/, '');
  const dir = path.dirname(file);
  const { df, half = 0, gain = 1, floor = 3, parts = false } = ctx;
  // §5.3 step 3's shape, and phase 8 asked the remaining question about it: the
  // strictly-positive `idf` (§5.3 step 4) is the principled weight, and §9 carried
  // "IDF is the principled divisor and loses on one metric" as an unresolved bullet.
  // Blended as `w = (1 - idfWeight)·(half/(half+df)) + idfWeight·(idf/idfMax)` and
  // swept in one process against one tree, every non-zero setting is a tie or a loss
  // on the metrics that ship: 0.25 and 0.5 read 0.8805/0.7818, identical to `half`'s
  // own, with windows that are *not* the same (the blend reorders without changing
  // what the window scored), and 0.75 and 1 fall to 0.8435/0.7636 with unoffered
  // 12 to 13. The only movement anywhere is MRR rising 0.0119 at 0.25 while nDCG
  // falls 0.0026 - phase 7's distrust shape at its smallest. So the design's formula
  // as written stays on the path, and the resolution §9 hoped for - recall weight on
  // the path, IDF on the symbol edge - is unavailable, because the symbol edge was
  // rejected in this same phase. The bullet is scoped, not closed.
  const w = (t) => (half > 0 && df ? gain * (half / (half + (df.get(t) || 0))) : 1);
  // The priors - entry point, config, recency - are deliberately left at their
  // absolute values rather than scaled with the token hits, and that was measured
  // rather than assumed: scaling them to the weight of a single-path token costs
  // macro recall (0.8435 to 0.8361), micro (0.7636 to 0.7455), nDCG (0.6454 to
  // 0.6218) and one unoffered file. So the priors are strong against the new token
  // scale and the harness prefers it that way. The cost is a small tree where the
  // recency bucket (~5) rivals a basename hit (~5), which the tie test in
  // tests/test.mjs pins.
  //
  // Phase 8 re-asked this jointly, with the priors swept as one scale against a
  // scorer carrying the declaration fan-out as a fourth signal, and the third
  // rejection is the same shape as the first two: macro and micro plateau from 0.75
  // to 1.5 (0.8805/0.7818 at every setting, on windows that are not identical), and
  // everything above 1.5 moves only MRR and nDCG upward while macro falls to 0.8551,
  // micro to 0.7273 and unoffered rises 12 to 15. Phase 7's rule - "MRR and nDCG
  // rise while recall falls, which is the shape to distrust" - is why the bar for
  // this one was set at +3 macro rather than the +2 the rest of the phase used, and
  // no setting reaches it. So the priors keep their absolute values, and §9's
  // bullet is now a third measurement rather than a carried caveat.
  //
  // **§5.3's `1 − coverage` recency weight was implemented, measured, and not
  // shipped, and the number is the finding.** Recency coverage here is exactly
  // 1.0000 - all 68 rankable files appear in the last 200 commits - so the section's
  // own rule sets the bonus to zero everywhere. Doing that costs macro 0.8805 to
  // 0.7889, micro 0.7818 to 0.5818, unoffered 12 to 23, and takes `zeroRuns` 0 to 3.
  // §5.3 is right that the signal carries no information; what the measurement adds
  // is that on this corpus the bonus carries nine points of macro recall anyway,
  // because the gold set is what an agent *read* and that is itself correlated with
  // what changed recently. The benchmark cannot separate "found the right file" from
  // "listed the file git just touched", which is a fact about the corpus and not
  // about the correction. Recorded in §9; the correction is unshipped rather than
  // the bonus being justified.
  let score = 0;
  // A basename hit is the strongest signal available without reading the file: the
  // task named the thing, and this file is called that.
  let stemHit = 0;
  for (const t of tokenize(stem, floor)) if (tokens.has(t)) stemHit += 10 * w(t);
  let dirHit = 0;
  for (const t of tokenize(dir, floor)) if (tokens.has(t)) dirHit += 4 * w(t);
  score += stemHit + dirHit;
  let entry = 0;
  if (ENTRY_POINT.test(base)) entry = 3;
  let config = 0;
  if (CONFIG_FILE.test(base)) config = 1;
  score += entry + config;
  let recent = 0;
  const rank = recentRank.get(file);
  if (rank !== undefined) recent = rank < 20 ? 5 : rank < 60 ? 3 : 1;
  score += recent;
  return parts ? { score, parts: { stem: stemHit, dir: dirHit, entry, config, recent } } : { score, parts: null };
}

// Paths whose stem matches a selected source's stem - the test for a file that was
// picked up on recency or entry-point alone.
function testSiblings(files, selected) {
  const stems = new Set(selected.map((f) => path.basename(f).replace(/\.[^.]+$/, '').replace(/\.(test|spec)$/, '')));
  return files.filter((f) => TEST_FILE.test(f) && stems.has(path.basename(f).replace(/\.[^.]+$/, '').replace(/\.(test|spec)$/, '')));
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
export function importGraph(root, files, cache) {
  const known = new Set(files);
  const imports = new Map();
  const importedBy = new Map();
  for (const f of files) { imports.set(f, new Set()); importedBy.set(f, new Set()); }
  for (const file of files) {
    if (!SOURCE_FILE.test(file)) continue;
    const text = sourceText(root, file, cache);
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
// `1 + n` rather than `n`, so a seed with one neighbour keeps most of its pull and
// the divisor only bites on a seed that fans out. Swept as its own axis in phase 8
// against `1 + sqrt(n)` and against no divisor at all, in one process on one tree:
// removing it reads macro 0.8805 to 0.6954, micro 0.7818 to 0.4182, unoffered 12 to
// 32, and `zeroRuns` 0 to 3 - the three Mission Control runs, which is the
// phenomenon `declaredBy` records for the *other* relation and which phase 8 found
// reproduces here at the shipped weight. `sqrt` is between the two and loses to both
// on the shipping metrics. §9's divisor bullet is corroborated on this relation.
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
export function declarations(root, files, cache) {
  return declarationIndex(root, files, cache).defines;
}

// The declaration pass, keeping the per-file name sets as well as the inverted
// index. §5.1's reference scan needs both: the index to know which files declare a
// token, and the name sets to subtract a file's own declarations from the mentions
// of that token inside it. One pass, because the reads are the cost.
export function declarationIndex(root, files, cache) {
  const defines = new Map();
  const names = new Map();
  for (const file of files) {
    if (!SOURCE_FILE.test(file)) continue;
    const text = sourceText(root, file, cache);
    if (!text || text.includes('\u0000')) continue;
    const declared = new Set();
    for (const re of DECLARATION) {
      // `matchAll` clones the regex and copies `lastIndex`, so a shared global
      // pattern is safe only while nothing leaves it advanced. Resetting says so
      // rather than relying on it.
      re.lastIndex = 0;
      for (const m of text.matchAll(re)) declared.add(m[1]);
    }
    names.set(file, declared);
    for (const name of declared) {
      for (const key of new Set(tokenize(name))) {
        if (!defines.has(key)) defines.set(key, new Set());
        defines.get(key).add(file);
      }
    }
  }
  return { defines, names };
}

// §5.1's other half: which files *mention* a name, as opposed to which files
// declare one. Aider's repo map needs both directions - a symbol's definers and its
// referencers - and until this existed the ranker had only the declaration half.
//
// The subtraction is what makes this a different relation rather than a noisier
// copy of `declarations`: a file that declares `route` mentions it too, and
// counting that would make every declaring file its own strongest reference.
// `refs(f, t)` is therefore the mentions of identifiers tokenizing to `t` inside
// `f`, less the number of names `f` declares that tokenize to `t`, floored at zero.
//
// Mentions are counted per identifier rather than per occurrence of the token, so a
// name used five times weighs five and a name used once weighs one - the usage
// signal Aider's PageRank is built on - while the floor is on the token, because a
// token can be declared once and mentioned once under two different identifiers.
//
// Recorded rather than scored in this commit. §5.1 is the phase's largest piece and
// the cheapest way to find out whether it is worth building is to count what the
// relation reaches that the ranker already reaches by another route.
export function references(root, files, declared, floor, cache) {
  const refs = new Map();
  // Identifiers repeat heavily across a repository and `tokenize` is the expensive
  // part of this pass - the regex scan is a few ms and the splits were 25 of the
  // measured 29. One memo for the call, keyed on the identifier and the floor.
  const split = new Map();
  const tokensOf = (name) => {
    let got = split.get(name);
    if (got === undefined) {
      got = new Set(tokenize(name, floor));
      split.set(name, got);
    }
    return got;
  };
  for (const file of files) {
    if (!SOURCE_FILE.test(file)) continue;
    const text = sourceText(root, file, cache);
    if (!text || text.includes('\u0000')) continue;
    const mentions = new Map();
    IDENTIFIER.lastIndex = 0;
    for (const m of text.matchAll(IDENTIFIER)) mentions.set(m[0], (mentions.get(m[0]) || 0) + 1);
    const counts = new Map();
    for (const [ident, n] of mentions) {
      for (const key of tokensOf(ident)) counts.set(key, (counts.get(key) || 0) + n);
    }
    const self = new Map();
    for (const name of declared.get(file) || []) {
      for (const key of tokensOf(name)) self.set(key, (self.get(key) || 0) + 1);
    }
    for (const [key, n] of counts) {
      const own = n - (self.get(key) || 0);
      if (own <= 0) continue;
      if (!refs.has(key)) refs.set(key, new Map());
      refs.get(key).set(file, own);
    }
  }
  return refs;
}

// `[A-Za-z_$][\w$]*` is the identifier shape both `DECLARATION` and this scan use,
// so the two agree about what a name is. Splitting is `tokenize`'s job, not this
// regex's: the scan counts identifiers, `tokenize` says which tokens each holds.
const IDENTIFIER = /[A-Za-z_$][\w$]*/g;

// One read per source file per `relevantFiles` call. Three passes now want the same
// text - the import graph, the declarations and the references - and each reading
// independently costs the same 648 KB. Measured before this: 7.0 ms for the graph
// and 8.8 ms for the declarations inside a 45.8 ms call, both dominated by the reads
// rather than by the regexes.
//
// Bounded at the same 2 MB the render treats as too big to inline, so the cache
// cannot hold a repository the prompt itself would refuse to. Past the cap reads
// still happen and are simply not kept, which costs the second reader of a large
// file its hit rather than the memory.
const SOURCE_CACHE_MAX = 2 * 1024 * 1024;

function sourceCache() {
  return { map: new Map(), bytes: 0 };
}

function sourceText(root, file, cache) {
  if (!cache) return readText(path.join(root, file));
  const hit = cache.map.get(file);
  if (hit !== undefined) return hit;
  const text = readText(path.join(root, file));
  if (cache.bytes < SOURCE_CACHE_MAX) {
    cache.map.set(file, text);
    cache.bytes += text ? text.length : 0;
  }
  return text;
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
    // **Undivided was rejected, and phase 8 re-measured why it was rejected.**
    // §5.3's rule is the argument: a signal whose weight does not fall with its
    // coverage is a signal that will drown the window on the queries where coverage
    // is all it has. The numbers originally recorded here - 0.873 undivided against
    // 0.855, and the three Mission Control runs going from 0.182/0.250/0.211 to
    // 0.000 - were measured at a different constant set and **do not reproduce on
    // this tree**. What the phase-8 sweep finds at the shipped `define: 12` is the
    // weaker version: undivided reads 0.8630/0.7455 with unoffered 14 against
    // 0.8805/0.7818 with 12, and `zeroRuns` stays 0 for every divisor including
    // none, so at this weight the fan-out never takes a window to zero relevant
    // files. `linear` (dividing by the full count) is 0.8551/0.7273/15, worse still.
    //
    // The empty-window phenomenon is real and phase 8 found where it lives: on the
    // *import* edge, at the shipped `edge: 2`, where removing that divisor takes
    // `zeroRuns` 0 to 3 - the same three Mission Control runs - and unoffered 12 to
    // 32. On this edge it takes `define: 60` to reproduce (zeroRuns 0 to 3), and at
    // that weight the undivided variant is *better* on every metric, which says the
    // divisor here is damping a harm the weight itself causes rather than preventing
    // one. So the two divisors are not one argument made twice: `1 + n` on the import
    // edge is load-bearing at full strength, and `sqrt(n)` here is a scale choice
    // that the ordinary metrics prefer. §9 carries both readings.
    const w = weight / Math.sqrt(files.size);
    for (const file of files) pull.set(file, (pull.get(file) || 0) + w);
  }
  return pull;
}

// -- the render -------------------------------------------------------------

// §5.5's render constants. `OUTLINE_HEAD` is 12 because a file's first lines are
// its imports and its module comment, which are the one part of a file whose
// position is guaranteed; `OUTLINE_COLS` is the section's own 100; `OUTLINE_BODIES`
// is small because a task that names three symbols in one file is a task about the
// file, and 2000 characters is already most of it.
const OUTLINE_HEAD = 12;
const OUTLINE_COLS = 100;
const OUTLINE_BODIES = 2;

// Reads a file for the prompt: whole, as its surface, or as the head of it.
// Binary-looking and oversized files are represented by their path alone rather
// than by a wall of noise. `tokens` is the task's own token set, which is what
// decides whose body the surface carries.
function readForPrompt(root, file, tokens, cfg) {
  try {
    const stat = fs.statSync(path.join(root, file));
    if (stat.size > 2 * 1024 * 1024) return null;
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    if (text.includes('\u0000')) return null;
    // §5.5. `fileChars` is the whole per-file cap and the three forms are three
    // ways of spending it: a file at or under it is inlined whole and nothing about
    // the render changed, a larger source file is sent as its surface, and anything
    // else is sent as the head it always was. Before this the second case was the
    // third: on this repository that truncated nine of fifteen slots in a typical
    // context, and what it cut was usually the declaration the task was about.
    if (text.length <= cfg.fileChars) return text;
    const surface = SOURCE_FILE.test(file) ? outline(text, tokens, cfg) : null;
    if (surface !== null) return surface;
    return `${text.slice(0, cfg.fileChars)}\n… (truncated, ${text.length} chars total)`;
  } catch {
    return null;
  }
}

// One-based lines: the outline's numbers are line numbers, and the agent is meant
// to read them back out with a ranged read.
function lineStarts(text) {
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}

// Binary search rather than a running counter, because the declaration pass walks
// matches in index order across six patterns at once and a cursor would have to be
// rewound per pattern.
function lineOf(starts, index) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

// The lines directly above a declaration that are comments. This is the part of a
// file a reader reaches for and the part an outline of signatures alone throws away
// entirely: this repository writes the *why* in the comment and the *what* in the
// signature, so a list of signatures is a list of names. Aider's rule, and it needs
// no parser - a line that starts with a comment marker is a comment line. Being
// wrong about a line inside a template literal costs a line of a string.
const COMMENT_LINE = /^\s*(\/\/|#|\/\*|\*|--)/;

// How many of those lines are kept. Three covers the two- and three-line comments
// this codebase writes above nearly every declaration.
const OUTLINE_ABOVE = 3;

// §5.5's render. The declaration patterns are the ones the `define` pass matches
// with, deliberately: the outline shows exactly the things retrieval treats as
// symbols, so a file cannot be an answer for a name its own outline does not show.
//
// `⋮...` marks content that was dropped, and only that: what is drawn is the head,
// as many declarations as the cap allows with the comment block above each one, and
// the body of any declaration the task names.
//
// The cap is `fileChars` - the same cap the head it replaces is cut to - so the
// surface can never be larger than the form it stands in for. That is the whole
// claim: it is the same budget spent on better characters. `null` means this file
// has nothing to render, and the caller should send the head.
function outline(text, tokens, cfg) {
  const lines = text.split('\n');
  const starts = lineStarts(text);
  const decls = new Map();
  for (const re of DECLARATION) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const n = lineOf(starts, m.index);
      if (!decls.has(n)) decls.set(n, m[1]);
    }
  }
  const rows = [...decls.keys()].sort((a, b) => a - b);
  if (!rows.length) return null;

  // The declarations the task names, which is §5.4's second stage - file, then
  // function - and the thing that keeps the outline from being a table of contents
  // for a file the agent then has to read in full anyway. Matched on the same
  // tokenizer the retriever scores with, so a name the ranking could not see is a
  // name the outline will not carry either.
  const named = new Set();
  for (let i = 0; i < rows.length && named.size < OUTLINE_BODIES; i++) {
    if (tokenize(decls.get(rows[i]), 2).some((t) => tokens.has(t))) named.add(rows[i]);
  }

  const out = [];
  let spent = 0;
  let body = 0;
  // The listing is drawn in file order, so a long file's early declarations would
  // spend the cap before reaching the one the task named. The reserve is what makes
  // the named body survive that - §5.4 says the file then the function, and a
  // function the listing elided on the way past is not a narrowing.
  const listing = cfg.fileChars - (named.size ? Math.min(cfg.matchedChars, cfg.fileChars / 2) : 0);
  const draw = (n, whole) => {
    const t = lines[n - 1] || '';
    const row = `${String(n).padStart(4)} │${whole ? t : t.slice(0, OUTLINE_COLS)}`;
    spent += row.length + 1;
    out.push(row);
  };
  const head = Math.min(rows[0] - 1, OUTLINE_HEAD);
  for (let i = 0; i < head && spent < listing; i++) draw(i + 1);
  let prev = head;
  let rest = rows.length;
  for (let i = 0; i < rows.length; i++) {
    const n = rows[i];
    // Walk up from the declaration through its comment block, stopping at the
    // previous declaration so a file whose every declaration is commented cannot
    // draw the same line twice.
    const lead = [];
    for (let k = n - 1; k > prev && lead.length < OUTLINE_ABOVE && COMMENT_LINE.test(lines[k - 1] || ''); k--) lead.unshift(k);
    // One blank line above the block belongs to it: it is the separation from
    // whatever came before, and drawing it costs a line and saves a `⋮...`.
    if (lead.length && lead[0] > prev + 1 && !(lines[lead[0] - 2] || '').trim()) lead.unshift(lead[0] - 1);
    // A row is at most `OUTLINE_COLS` characters plus its gutter, so the group is
    // measured at its worst rather than drawn and then measured.
    if (spent + (OUTLINE_COLS + 6) * (lead.length + 1) > listing) { rest = i; break; }
    if ((lead.length ? lead[0] : n) - prev - 1 > 0) out.push('     ⋮...');
    for (const k of lead) draw(k);
    draw(n);
    prev = n;
    if (!named.has(n)) continue;
    // A declaration ends where the next one starts, which is the only end available
    // without a parser and is wrong only for code that declares inside a body.
    const end = i + 1 < rows.length ? rows[i + 1] - 1 : lines.length;
    let cut = false;
    for (let j = n; j < end && j < lines.length; j++) {
      const len = lines[j].length + 1;
      if (body + len > cfg.matchedChars || spent + len > cfg.fileChars) { cut = true; break; }
      body += len;
      draw(j + 1, true);
      prev = j + 1;
    }
    if (cut) out.push('     ⋮...');
  }
  if (rest > 0) out.push(`     ⋮... (${rest} more declarations)`);
  return out.join('\n');
}

// Ranks every file in the tree against the task and returns the best few, with
// their contents. Deterministic: no model is consulted, and the same task against
// the same tree always produces the same list.
export function relevantFiles(project, task, options = {}) {
  const cfg = contextConfig(options.config);
  const root = options.cwd || project.path;
  const limit = options.limit ?? cfg.files;
  const files = inspect(root).files;
  const tokens = new Set(tokenize(`${task.title || ''} ${task.description || ''} ${task.plan || ''}`, cfg.floor));
  const recent = options.recent ?? recentFiles(root);
  const recentRank = new Map(recent.map((p, i) => [p, i]));

  // Lockfiles and bundles stay in the tree but never earn a slot. Filtered here
  // rather than at the walk so the tree still lists them.
  const rankable = files.filter((f) => !NOISE_FILE.test(f));

  // §5.7's ceiling needs a df whether or not the weight is on, and §5.9's `NO_RESULTS`
  // needs the coverage it yields, so the table is built unconditionally - one
  // `tokenize` per path, measured at 0.23 ms for this repository's 68. `dfHalf: 0`
  // leaves the score unweighted; it no longer leaves the table unbuilt.
  const trace = cfg.debug ? {} : null;
  const cache = sourceCache();
  const t0 = trace ? performance.now() : 0;
  const df = pathDocFreq(rankable, cfg.floor);
  const tDf = trace ? performance.now() : 0;
  const scored = rankable.map((file) => {
    const s = scoreFile(file, tokens, recentRank, { df, half: cfg.dfHalf, gain: cfg.gain, floor: cfg.floor, parts: !!trace });
    return trace ? { path: file, score: s.score, parts: s.parts } : { path: file, score: s.score };
  }).filter((f) => f.score > 0);
  const tScore = trace ? performance.now() : 0;
  // Ties break on the raw code-point order of the path, not `localeCompare`. The
  // locale-aware comparison is ICU-dependent: it orders `_`, `-` and case
  // differently under different locales, so the same repo produced different
  // contexts on two machines - which breaks the cache and the reproducibility the
  // ranking is supposed to have. Nearly every score here is a tie, so this is not
  // a cosmetic difference.
  const byPath = (a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  scored.sort(byPath);

  // §5.9's `DEGRADED`. Not a state on top of the ranking - a replacement for it.
  //
  // With no query there is nothing to rank, and the scorer cannot express that:
  // entry point, config and recency are *added to* every score rather than being a
  // category a file can be in, so `scored` is non-empty in any tree that has one
  // of the three, and the "fallback" above was an order rather than a branch. That
  // is why the state had never been reachable and why the defect below it survived:
  // `tokenize('a', 2)` is `[]`, so the empty query fell through to `NO_RESULTS`,
  // whose note then read "Terms that matched nothing: ." - an empty list inside a
  // sentence.
  //
  // Paths only, `contents: []`. Nothing is read, which is what makes a list this
  // long cheap, and `manifest.files === []` is the shape that already means "no
  // file body claims to have been ranked" - so the fallback composes with the
  // contract in `buildTaskContext` rather than inventing a second one.
  if (!tokens.size) {
    const floor = heuristicFloor(rankable, recent, cfg);
    const rankState = floor.length
      ? { state: 'DEGRADED', note: 'The task text produced no searchable terms, so this is a listing rather than a ranking: configuration, then entry points, then recently changed files. Search for what you need.' }
      : { state: 'EMPTY', note: 'Nothing in this repository scored against the task; the file tree below is all of it. Search for what you need.' };
    const tFloor = trace ? performance.now() : 0;
    const contentHash = trace ? contentDigest(root, files, cache) : null;
    const tHash = trace ? performance.now() : 0;
    // The three passes that did not run are marked at the point they would have
    // started, so their buckets come back as 0 rather than as a share of the
    // floor's cost. A timing that credits the declaration pass with work it never
    // did is worse than a missing one.
    const debug = trace ? debugRecord({ task, cfg, rankable, files, tokens, df, scored, selected: floor, limit, state: rankState.state, contentHash, ref: null, marks: { t0, tDf, tScore, tDefine: tScore, tEdge: tScore, tGraph: tScore, tRef: tFloor, tHash: tFloor, tEnd: tHash } }) : null;
    // The floor's overflow is the tail, not part of `paths`: `paths` is the window
    // and the widening is the extra names, in this branch as in the other one. It is
    // the same split, so `manifest.tree` and the harness's `tail` field need no
    // special case for a degraded run.
    return { paths: floor.slice(0, limit), tail: floor.slice(limit), contents: [], scores: scored, debug, ...rankState };
  }

  // The task names a symbol; the file that declares it is the file the task is
  // about. Runs before the graph pass for the reason §5.1 gives: a file the graph
  // could reach but had no seed for is reachable now, because this pass supplies
  // the seed. The defining file enters the list above the edge pass, so it is
  // within `seeds` and its own imports are followed.
  const tDefine = trace ? performance.now() : 0;
  // The declaration pass is shared with the reference record at the bottom, which
  // needs the same per-file name sets, so it is built once for either consumer.
  const idx = cfg.define > 0 || trace ? declarationIndex(root, rankable, cache) : null;
  if (cfg.define > 0) {
    const entry = new Map(scored.map((f) => [f.path, f]));
    for (const [p, add] of declaredBy(tokens, idx.defines, cfg.define)) {
      const hit = entry.get(p);
      // `define` marks a score that came from a declaration rather than from the
      // path, for the same reason `graph` does: it is the first thing a reader of
      // this list will ask about. The magnitude is kept alongside the flag so the
      // debug record can say *how much* of a file's score the fan-out accounts for
      // - a flag alone cannot distinguish a marginal boost from a file that is only
      // in the list at all because of it.
      if (hit) { hit.score += add; hit.define = (hit.define || 0) + add; }
      else scored.push({ path: p, score: add, define: add });
    }
    scored.sort(byPath);
  }


  // One hop out from the files the lexical pass picked, which is where the seven
  // named misses in §2.4 live: they score nothing lexically - `src/service.mjs`
  // shares no token with the task - while every one of them is named by a file
  // that already won a slot. A file the frontier introduces starts from 0 and is
  // carried entirely by the pull, which is the point: it has no lexical evidence
  // to be ranked on.
  const tEdge = trace ? performance.now() : 0;
  if (cfg.edge > 0 && scored.length) {
    const entry = new Map(scored.map((f) => [f.path, f]));
    const strength = new Map(scored.map((f) => [f.path, f.score]));
    const seeds = scored.slice(0, limit).map((f) => f.path);
    const pull = frontier(seeds, strength, importGraph(root, rankable, cache), cfg.edge);
    for (const [p, add] of pull) {
      const hit = entry.get(p);
      // A neighbour already in the list keeps its own lexical score and gains the
      // pull on top; one the lexical pass never scored enters on the pull alone.
      // `graph` marks which, because a score that appears from nowhere is the
      // first thing a reader of this output will ask about.
      if (hit) { hit.score += add; hit.graph = (hit.graph || 0) + add; }
      else scored.push({ path: p, score: add, graph: add });
    }
    scored.sort(byPath);
  }

  // §5.1's PageRank over the symbol graph stood here in phase 8 and was removed:
  // see §9. The reference scan above stays, because `ref` is what made the
  // rejection legible rather than a matter of taste.
  const tGraph = trace ? performance.now() : 0;

  const selected = scored.slice(0, limit).map((f) => f.path);
  // Second pass, so a test file is picked up for the source it covers even when
  // the task never named it.
  for (const sibling of testSiblings(files, selected)) {
    if (!selected.includes(sibling) && selected.length < limit + 5) selected.push(sibling);
  }

  const contents = [];
  for (const file of selected) {
    const text = readForPrompt(root, file, tokens, cfg);
    if (text !== null) contents.push({ path: file, text, tokens: estimateTokens(text) });
  }
  // §5.1's reference relation, recorded rather than scored. `reached` is every file
  // that mentions a query token; `only` is the part of it the ranker did not reach
  // by any other route - not the lexical window, not a declaration, not the import
  // frontier, not a test sibling. That difference is what the symbol graph would
  // have been buying, and counting it before building it is what made the rejection
  // in §9 a measurement rather than an opinion. It stays now that the graph is gone:
  // the number it produces is the standing answer to "would a wider index help".
  // The reference index, built only for the record below. It is the expensive pass
  // - tens of ms against a single-digit total for everything else - which is the
  // third reason the graph was not worth keeping: the scan that was meant to feed it
  // is now the largest cost in a call whose output it cannot change.
  const tRef = trace ? performance.now() : 0;
  const refs = idx ? references(root, rankable, idx.names, cfg.floor, cache) : null;
  let ref = null;
  if (refs) {
    const reached = new Set();
    let hit = 0;
    for (const t of [...tokens].sort()) {
      const files2 = refs.get(t);
      if (!files2) continue;
      hit++;
      for (const f of files2.keys()) reached.add(f);
    }
    const known = new Set([...scored.map((f) => f.path), ...selected]);
    const inWindow = new Set(selected);
    ref = {
      // How many of the query's tokens appear as names anywhere in the tree, which
      // is the vocabulary the reference index has that the path index does not.
      tokens: hit,
      reached: reached.size,
      // Beyond the offered window: a file a reference pull could move *into* the
      // window. This is the discriminating half, because it can be non-zero.
      beyond: [...reached].filter((f) => !inWindow.has(f)).sort(),
      // Beyond everything the ranker scored at all. On this corpus this is empty
      // for any relation, because the recency prior scores 68 of 68 files - so it
      // is recorded as the reason the introduction question cannot be asked here
      // rather than as evidence about the reference relation.
      only: [...reached].filter((f) => !known.has(f)).sort(),
    };
  }

  const rankState = rankingState(scored, tokens, df, rankable.length);
  const tHash = trace ? performance.now() : 0;
  const contentHash = trace ? contentDigest(root, files, cache) : null;
  const tEnd = trace ? performance.now() : 0;
  const debug = trace ? debugRecord({ task, cfg, rankable, files, tokens, df, scored, selected, limit, state: rankState.state, contentHash, ref, marks: { t0, tDf, tScore, tDefine, tEdge, tGraph, tRef, tHash, tEnd } }) : null;
  // §5.14. `selected` is the window plus test siblings, and the tail is built from
  // `scored` past `limit` - so at `widen: 1` it is `[]` and this call is what it was
  // before the key existed, byte for byte.
  const tail = tailFor(scored, selected, limit, cfg, rankState.state);
  return { paths: selected, tail, contents, scores: scored, debug, ...rankState };
}

// §5.9's `DEGRADED` list. Not a second ranking - there is no query to rank against
// - but the three things the scorer treats as priors, in an order chosen for a
// reader rather than inherited from the weights: configuration first, because a
// task with no text is usually a request to be told how the repository works and
// how to run it; then entry points, which is where a change gets wired in; then the
// rest of the recent set in recency order.
//
// That order is deliberately *not* the priors' order. The scorer weights an entry
// point 3 and a config 1, so the ranking it produced for an empty query put entry
// points first. A config file that names the commands is more use to an agent with
// nothing to go on than a second entry point, and this list has no score to be
// consistent with.
//
// Alphabetical inside a class rather than by rank: with no tokens every score in a
// class is identical, and the code-point comparison is the same tie-break the
// ranking's own sort uses. Capped at `cfg.files * cfg.widen`, which is §5.14's cap
// rather than a second one - a 3-5x list is only affordable because this returns
// paths.
function heuristicFloor(files, recent, cfg) {
  const present = new Set(files);
  const sys = files.filter((f) => CONFIG_FILE.test(path.basename(f))).sort();
  const entry = files.filter((f) => ENTRY_POINT.test(path.basename(f))).sort();
  // The two patterns are disjoint - a name that ends in `rc` cannot also be an
  // entry point, whose extension is the thing being matched - so the set only has
  // to hold `recent` off the first two classes. That is the common overlap, not a
  // contrived one: an entry point is a file git touched.
  const seen = new Set([...sys, ...entry]);
  const rest = recent.filter((f) => present.has(f) && !seen.has(f));
  return [...sys, ...entry, ...rest].slice(0, Math.max(1, cfg.files * cfg.widen));
}

// §5.14's widening: the names below the window, as a field of their own rather
// than a longer `paths`.
//
// A separate field because `paths` is what the five metrics score and what the
// ladder's rungs reason about, and `testSiblings` already appends to it past
// `limit` without the harness seeing it. A tail expressed as "everything in `paths`
// past `limit`" would make that quiet behaviour load-bearing and would make the
// only strong statement available - that widening changes *nothing* about the
// window - unassertable. With the tail named, the guard is exact equality.
//
// The states that widen are the two where the ranking has nothing to say: no
// lexical evidence at all (`NO_RESULTS`) and no query at all (`DEGRADED`). `FULL`
// means the window is ranked on evidence, and §5.14's own argument is about the
// tasks where there is none. `widenOn: 'always'` overrides that, which is what
// makes the trigger itself measurable rather than assumed.
//
// `scored.slice(limit, ...)` starts where the window's own slice ends, so a name
// the window already offers can never appear twice; the `have` filter catches a
// test sibling, which is appended to `paths` from outside `scored`'s order.
const WIDEN_STATES = new Set(['NO_RESULTS', 'DEGRADED']);
function tailFor(scored, selected, limit, cfg, state) {
  const cap = Math.round(limit * cfg.widen);
  if (cap <= limit) return [];
  if (cfg.widenOn !== 'always' && !WIDEN_STATES.has(state)) return [];
  const have = new Set(selected);
  return scored.slice(limit, cap).map((f) => f.path).filter((p) => !have.has(p));
}

// §5.9's states, as far as the ranker alone can decide them. `PARTIAL` is not here
// because it is a fact about the walk rather than the ranking, and the walk is
// `buildTaskContext`'s to report; `DEGRADED` is not decided here but in
// `relevantFiles`, because it replaces the list rather than labelling it. `WEAK`
// still does not exist: §5.10 measured the floor as having nothing to calibrate
// against, and §9 carries why.
//
// The order is the order of the claims: nothing scored at all is the strongest
// statement, then nothing matched the query, then the ordinary case. This is only
// reached with a non-empty token set - the empty one returns `DEGRADED` above -
// which is what makes the `NO_RESULTS` note below safe to write as a list of terms.
function rankingState(scored, tokens, df, n) {
  if (!scored.length) return { state: 'EMPTY', note: 'Nothing in this repository scored against the task; the file tree below is all of it. Search for what you need.' };
  const { coverage } = ceilQuery(tokens, df, n);
  if (coverage === 0) {
    // Only the terms with no path anywhere. Today that is every token, because
    // `coverage === 0` has no other cause; the condition is written against `df`
    // rather than against the token set because §5.5's retry can reach this branch
    // with part of its vocabulary present but unscored, and a note naming those
    // terms would tell the reader a word is absent from a tree that contains it.
    //
    // Capped, because this note is inside the context JSON and so counts against
    // the budget the ladder is trying to fit: a task text long enough to have
    // hundreds of unmatched tokens would otherwise push the file list out to make
    // room for a list of the words that found nothing, which is the trade the note
    // exists to avoid.
    const missing = [...tokens].filter((t) => !(df.get(t) > 0)).sort();
    const shown = missing.slice(0, 12).map((t) => `\`${t}\``).join(', ');
    const rest = missing.length > 12 ? `, and ${missing.length - 12} more` : '';
    // Two situations reach this state and they look nothing alike downstream. The
    // declaration pass indexes the *names inside* files as well as their paths, so a
    // query absent from every path can still be answered - `{title:'widget'}` here
    // returns the file that declares `widgetRunner`. In that case the list is a
    // match and the sentence "the tree below is a starting point" is false about it.
    // Coverage is the right condition either way, because it is a path fact and the
    // path is what a reader will check; the note is what has to tell the two apart.
    const named = scored.some((f) => f.define > 0);
    const opening = named
      ? `No task term appears in any path in this repository, but the files below declare a name one of the terms is part of, so this list is a match rather than a guess. Terms with no path anywhere: ${shown}${rest}.`
      : `No task term appears in any path in this repository. The tree below is a starting point. Terms that matched nothing: ${shown}${rest}.`;
    return { state: 'NO_RESULTS', note: opening };
  }
  return { state: 'FULL', note: null };
}

// §5.10's debug record. Everything §5.7 needs to calibrate against, from the one
// run that produced the ranking: the candidate list with its score decompositions,
// the query's ceiling and coverage, the dispersion, and the hashes that say whether
// two records are comparable at all.
//
// `normScore` divides our additive score by §5.7's idf ceiling. Those are two
// different scales - the numerator weights a path token `W/(W+df)` and the
// denominator weights it `log(1 + (N-df+0.5)/(df+0.5))` - so the quotient is not
// the `[0,1)` quantity §5.7 defines for BM25, and it is not a floor that can be
// tuned against: measured over the harness it separates gold from non-gold at the
// median (0.974 against 0.520) and then holds precision flat at 35.7% for every
// floor from 0.10 to 0.50. It is recorded because §5.7 asks for it and because the
// measurement that says it does not work is the useful part; §5.10 and §9 carry it.
const DEBUG_CANDIDATES = 200;
function debugRecord({ task, cfg, rankable, files, tokens, df, scored, selected, limit, state, marks, contentHash, ref }) {
  const n = rankable.length;
  const { ceil, coverage } = ceilQuery(tokens, df, n);
  const accepted = new Map(selected.map((p, i) => [p, i]));
  // §5.7's coverage quantities (§5.10 for the calibration, §9 for the verdict).
  //
  // The requirement §5.10 established is not "a floor on a score" but a quantity
  // that is **not monotone in `score`**, because a monotone quantity's floor
  // admits a top-`j` set and for `j >= limit` the offered set is bit-identical -
  // which is exactly the flat curve §5.10 recorded and misread as a fact about the
  // scorer's units. `normScore` is monotone by construction. `terms` and `cov` sum
  // over the same membership the score sums, so they are close to monotone too.
  // `rarest` is a max over terms against a sum-based score, and is the one
  // candidate that is structurally not.
  //
  // All three are bounded, per-file, finite without flooring, and computed from the
  // path index the scorer already built - no content is read.
  const vocab = [];
  for (const t of [...tokens].sort()) {
    const d = df.get(t) || 0;
    if (d > 0) vocab.push({ t, v: idf(d, n) });
  }
  const idfSum = vocab.reduce((a, x) => a + x.v, 0);
  const coverageOf = (file) => {
    const pt = pathTokens(file, cfg.floor);
    let cov = 0;
    let terms = 0;
    let rarest = 0;
    for (const x of vocab) {
      if (!pt.has(x.t)) continue;
      cov += x.v;
      terms += 1;
      if (x.v > rarest) rarest = x.v;
    }
    return {
      cov: idfSum > 0 ? round(cov / idfSum) : null,
      terms: vocab.length ? round(terms / vocab.length) : null,
      rarest: round(rarest),
    };
  };
  const candidates = scored.slice(0, DEBUG_CANDIDATES).map((f) => ({
    path: f.path,
    score: round(f.score),
    normScore: ceil > 0 ? round(f.score / ceil) : null,
    ...coverageOf(f.path),
    // A file the path pass never scored has no parts, but it does have a reason to
    // be here, and that reason is the whole content of its component record.
    components: f.parts || f.define || f.graph
      ? { ...Object.fromEntries(Object.entries(f.parts || {}).map(([k, v]) => [k, round(v)])), ...(f.define ? { define: round(f.define) } : {}), ...(f.graph ? { graph: round(f.graph) } : {}) }
      : null,
    accepted: accepted.has(f.path),
    // The ways a candidate fails to be accepted are the things a reader of this
    // record asks about first: it lost on score, or it was only ever in the list
    // because of one of the two graph passes. `test-sibling` is the one acceptance
    // that is not the ranking's own decision, and it is last because a file that
    // scored its way in is a stronger statement than one that was appended.
    reason: !accepted.has(f.path)
      ? !f.parts && f.define ? 'define-only, below cut' : !f.parts && f.graph ? 'graph-only, below cut' : 'below cut'
      : accepted.get(f.path) < limit ? 'scored' : 'test-sibling',
  }));
  const scores = scored.map((f) => f.score);
  return {
    task: { id: task.id, title: task.title || '' },
    corpus: { n, candidates: scored.length },
    ceil: round(ceil),
    coverage,
    terms: [...tokens].sort(),
    idfFloor: round(idfFloor(n)),
    nqc: round(nqc(scores)),
    branch: state,
    config: cfg,
    configHash: digest(cfg),
    treeHash: digest([...files].sort()),
    // Kept alongside `treeHash` rather than replacing it: the two answer different
    // questions and a record that only carried the new one could not be compared
    // against anything recorded before this phase.
    contentHash,
    // §5.1's reference relation, recorded and not scored. `refGold` is not here
    // because gold is a fact about the harness rather than about the ranker; the
    // harness intersects `only` with the case's own answer set and reports both.
    ref,
    timings: marks ? { df: round(marks.tDf - marks.t0), score: round(marks.tScore - marks.tDf), define: round(marks.tEdge - marks.tDefine), edge: round(marks.tGraph - marks.tEdge), ref: round(marks.tHash - marks.tRef), hash: round(marks.tEnd - marks.tHash) } : null,
    candidates,
    truncated: scored.length > DEBUG_CANDIDATES,
  };
}

// Three decimals is the resolution the weights are calibrated to; keeping full
// float noise in the record triples its size for digits nobody reads.
function round(v) {
  return typeof v === 'number' ? Number(v.toFixed(3)) : v;
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

// The task a task is linked to, summarised for the prompt of the one that builds
// on it. A description that says "continue what the parent task started" is
// unreadable to a planner that has never seen the parent, and the *state* is half
// of what makes it readable: a parent that is COMPLETE is work to build on, and one
// that is still PLANNING is work that has not happened yet.
//
// Read one level deep and no further, which is what makes an accidental cycle
// harmless: the parent's own parent is named by its id at most, never expanded.
// A parent row that has since been deleted, or a store that was not handed over,
// is nothing to say rather than a failure - a link is a human's annotation, and
// losing one must not cost a run.
function parentSummary(store, task) {
  if (!store || !task.parent_id) return null;
  try {
    const p = store.getTask(task.parent_id);
    if (!p) return null;
    const cut = (text, max) => (text && text.length > max ? `${text.slice(0, max)}\n… (truncated)` : text || null);
    return {
      id: p.id,
      title: p.title,
      state: p.state,
      description: cut(p.description, 800),
      review: cut(p.review, 1000),
    };
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
  // §5.6. `options.window` is the routed model's context length and `options.fixed`
  // is what the request carries outside this context, both supplied by the caller
  // because neither is knowable here. Absent a window the cap stands, which is what
  // every caller that is not a model call - the eval harness, `context show` -
  // wants. The derived value replaces `cfg.budget` before `relevantFiles` sees it,
  // so the debug record's config hash covers it: two runs with different windows
  // are not comparable and the hash has to say so.
  cfg.budget = windowBudget(options.window, options.fixed, cfg);

  const picked = relevantFiles(project, task, { ...options, cwd: root, config: cfg });

  // Sections in the order the spec fixes: what the project is, the files that
  // matter, the approved plan, then whatever the last attempt in this role left.
  const architecture = readDoc(project.path, 'architecture.md', cfg.architecture);
  const conventions = readDoc(project.path, 'conventions.md', cfg.conventions);
  let review = role === 'repair' || role === 'reviewer' ? task.review || null : null;
  // A chat run belongs to no task, so `previousSummary` has no id to scope its
  // query by - `listRuns(null)` returns every run in the database, and the
  // "previous attempt" a chat would be handed is some other conversation's
  // failure. The same reason the planner reads nothing: there is no earlier
  // attempt at this role that says anything about this question.
  let previous = role === 'planner' || role === 'chat' ? null : previousSummary(options.store, task, role);
  // Every role gets the parent, the planner first of all: the planner is the one
  // writing the plan a task's description is read against, so a description that
  // gestures at earlier work is exactly what it cannot resolve on its own. Absent a
  // link this is null and the context is byte-identical to what it was.
  let parent = parentSummary(options.store, task);

  const files = [...picked.contents];
  let arch = architecture;
  let conv = conventions;
  // The tree is capped up front, and the selected files are always in it: a path
  // the ranking picked is exactly the one the agent must be told about.
  //
  // §5.14's widened names sit directly behind them, and ahead of the rest of the
  // walk. This is the whole of the widening's effect on the prompt: the tail names
  // no file the tree would not have listed anyway, so what `cfg.widen` buys is their
  // *position* when the cap bites - the names the ranking considered and rejected
  // are listed before the ones it never considered at all. On a repository smaller
  // than `cfg.tree` nothing is dropped, so the tail costs nothing and buys nothing
  // there, which is the honest reading of a 68-file tree.
  const scanned = inspect(root);
  const full = scanned.files;
  const unreadable = scanned.unreadable || [];
  let tree = [...new Set([...picked.paths, ...picked.tail, ...full])].slice(0, cfg.tree);
  const size = () => estimateTokens(JSON.stringify({ tree, architecture: arch, conventions: conv, files, review, previous, parent }));
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
    // The tail survives this rung with the window, per §5.6: it is paths only, so it
    // is the cheapest thing in the context, and rung 4's job is to drop the walk
    // rather than the ranking's own output. The rungs below it then take the tail
    // last, because the geometric clamp slices from the end and the tail is at the
    // front - so the widened names are the last thing to go before the skeleton.
    tree = [...new Set([...picked.paths, ...picked.tail, ...files.map((f) => f.path)])];
    trimmed.push(`tree → ${tree.length} files`);
    total = size();
  }
  // Past this point every rung is unconditional. The ladder above has a floor it
  // cannot pass - it never pops the last file - so a context with one enormous file
  // or one enormous review left the assembler over budget and sent it anyway, which
  // is the single outcome a budget exists to prevent. A budget that can be exceeded
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
  // The parent goes last of the three, because it is the only one of them that is
  // about a different task: the review is what a repair is acting on and the
  // previous attempt is a retry signal, while a parent reference is background a
  // planner can do without - it is capped at construction, and this rung is what
  // makes even the capped block droppable when the budget has nothing left.
  while (total > cfg.budget && parent) {
    parent = null;
    trimmed.push('parent-task');
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
  // The rung that makes over-budget unrepresentable, which is §5.6's actual
  // requirement. Every rung above can stop one notch short: the geometric clamp
  // empties the tree, but `files` still names every path the ranking picked, and a
  // path is worth tokens. So this one has no guard - no `files.length > 1`, no
  // "keep the selected paths" - because a guard is exactly what left the old ladder
  // a rung short. After it, what remains is the fixed skeleton
  // `{tree:[],architecture:null,...,files:[]}`, whose size is a constant and which
  // is why the derived budget has a floor under it.
  while (total > cfg.budget && files.length) {
    trimmed.push(files.pop().path);
    total = size();
  }

  const manifest = {
    files: files.map((f) => ({ path: f.path, tokens: f.tokens })),
    // The file list is cheap and is what tells the agent where things live.
    tree: tree.length,
    sections: [arch && 'architecture', conv && 'conventions', task.plan && 'plan', review && 'review', previous && 'previous-run', parent && 'parent-task'].filter(Boolean),
    tokens: total,
    budget: cfg.budget,
    trimmed,
    // §5.14's count, present only when it is non-zero for the reason `unreadable`
    // is: at `widen: 1` the manifest has to stay byte-identical to what it was, and
    // a `widened: 0` on every run is the kind of field a reader learns to skip.
    ...(picked.tail?.length ? { widened: picked.tail.length } : {}),
    cwd: root,
    // §5.9. The ranker's own verdict, raised to `PARTIAL` when the walk could not
    // see the whole tree - a partial walk is a fact about the input, so it
    // overrides the ranking's own reading rather than the other way round. The
    // note is what the prompt carries: a list that arrives unlabelled is the
    // failure mode the table exists to prevent.
    ...degraded(unreadable, picked),
    // Present only when the walk was blocked somewhere, so the common case stays
    // byte-identical to what it was: a ranking that saw less than the whole
    // repository has to be distinguishable from a small repository, or the
    // degradation is invisible to every consumer downstream.
    ...(unreadable.length ? { unreadable } : {}),
  };

  // §5.10's sink. Written here rather than by the caller because this is the last
  // point that holds both the record and the project path, and written to disk
  // rather than into the return value because the return value is `JSON.stringify`d
  // into every prompt - a few KB of candidate scores in the context would be paid
  // for by the agent on every run. A failed write is not worth failing a run over
  // (§5.8): the record is diagnostic, and the run is not.
  if (picked.debug) {
    try {
      const dir = path.join(project.path, '.ai-code', 'context');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'ranker-debug.json'), JSON.stringify(picked.debug, null, 2));
    } catch { /* diagnostic only */ }
  }

  return {
    project: { id: project.id, name: project.name, path: root, language: project.language, framework: project.framework, commands: project.commands },
    task: { id: task.id, title: task.title, plan: task.plan },
    tree,
    architecture: arch,
    conventions: conv,
    files,
    review,
    previous,
    parent,
    manifest,
  };
}

// §5.9's `PARTIAL`, and the label that goes with every non-`FULL` state. Kept
// beside the manifest rather than inside `relevantFiles` because the walk is
// measured here and the ranking there, and the two disagree about which fact
// matters when both are true.
function degraded(unreadable, picked) {
  if (unreadable.length) {
    return { state: 'PARTIAL', note: `The file walk could not read ${unreadable.length} director${unreadable.length === 1 ? 'y' : 'ies'} (${unreadable.join(', ')}), so this listing is incomplete. Search for what is missing.` };
  }
  return picked.note ? { state: picked.state, note: picked.note } : { state: picked.state };
}

// §5.8's fallback. Exported rather than inlined into the service's catch, so the
// state a ranking failure lands in can be tested without provoking a real exception
// inside a live run - and so the shape it produces is the same shape the ladder
// bottoms out at, which is the property that makes it a degradation rather than a
// second, unrelated context format. `root` may be null: the ranking may have failed
// on the lookup that resolves the root in the first place.
export function treeOnlyContext(root, err) {
  let tree = [];
  try {
    if (root) tree = inspect(root).files.slice(0, 200);
  } catch { /* an empty listing is still a labelled one */ }
  const note = `The context ranker failed, so this is a plain file listing rather than a ranking (${err && err.message ? err.message : String(err)}). Search for the files you need rather than assuming the important ones are here.`;
  return {
    tree,
    architecture: null,
    conventions: null,
    files: [],
    review: null,
    previous: null,
    parent: null,
    manifest: {
      files: [], tree: tree.length, sections: [], tokens: estimateTokens(JSON.stringify(tree)),
      budget: 0, trimmed: [], cwd: root || null, state: 'FAILED', note,
    },
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
