# The context ranker: requirements, measurements, and design

`src/context.mjs` decides which files an agent sees. This document states what it
must do, measures what it does, and specifies the replacement.

Everything in §1 and §2 was measured against the live database
(`.ai-code/ai-code.db`) and the working tree on 2026-09-23. Claims sourced from
other systems are marked with the source; anything unverified is called out in §8.

---

## 1. Why this matters more than it looks

`relevantFiles()` returns `{paths, contents, scores}`. `buildTaskContext()`
trims it to a token budget and persists the manifest onto `task.context`.

Three properties of that output are not obvious from the function signature.

### 1.1 It is a safety input

`manifest.files[].path` → `contextPaths()` → `readPaths()` → `baseline.seen`,
which is the narrowing term of the execution gate at `src/service.mjs:745`:

```js
const blocked = dirtyPaths(p.path).filter((f) => touches(baseline.seen, f));
if (blocked.length) throw Object.assign(new Error(`PLAN_BASE_DIRTY: ...`), ...)
```

The ranker therefore sets the precision *and* recall of a soundness check, in
opposite failure directions:

- **Over-select** → a file that happens to be dirty lands in `seen` → spurious
  `PLAN_BASE_DIRTY` → the implementer refuses to start. `dirtyPaths()` returns
  "the twenty-odd unrelated entries a working repository carries"
  (`src/service.mjs:734`), so this is not hypothetical.
- **Under-select** → a file the plan rests on is absent from `seen` → the gate
  passes → the implementer builds on uncommitted state that is not in HEAD. The
  post-implement check at `src/service.mjs:784` does not catch this; it only
  re-examines `baseline.dirty`.

The code already concedes the second at `src/service.mjs:47`: "A file the planner
only reasoned about from the tree listing is not caught this way."

`src/service.mjs:1049` consumes `baseline.seen` a second time, for `premisesMoved`
in `port()`. Same coupling, second consumer.

### 1.2 It walks the repo twice per build

`inspect()` calls `walk()`; `relevantFiles()` calls it at `src/context.mjs:262`
and `buildTaskContext()` again at `src/context.mjs:331`. Plus one synchronous
`git log --name-only -n 200`, plus up to 15 × 12 KB reads. All synchronous, on
the critical path of a run whose timeout is 300–600 s.

### 1.3 It is not reconstructible

The manifest keeps paths, per-file token counts, tree count, total, budget,
`trimmed`, and cwd. It does not keep scores, the rejected candidates, or the
reason each file was chosen. `scores` is computed at `src/context.mjs:282` and
discarded. `runs.relevant_files` stores a count. When a planner reads 6 of 15 and
needs 7 it was never offered, nothing in the database can say which 7 or why.

---

## 2. Measurements

Task `53da01a5` — *"Make it easy to add new lines, instead of just an input
field."* Four planner attempts, all `deepseek-v4-pro`, three of them ending in
`TOOL_CALL_LIMIT` at 41 tool calls against a budget of 40, after 254 s, 100 s and
249 s. All four offered the same 15 files.

### 2.1 Precision and recall against what the planner actually opened

Ground truth is the set of paths the planner read with `Read`/`Grep`/`Glob`,
recovered from `events` (the same extraction `toolPaths()` performs at
`src/service.mjs:62`).

| | files |
|---|---|
| Offered **and** opened in all three | 4 — `src/cli.mjs`, `src/server.mjs`, `src/tui/screens/task.mjs`, `web/views/task-detail.mjs` |
| Offered in all three, opened in **none** | 6 — `.gitignore`, `.idea/material_theme_project_new.xml`, `AUDIT-PLANNER-SPIRAL.md`, `PLAN-PLATFORM.md`, `docs/ARCHITECTURE.md`, `package-lock.json` |
| Opened in all three, offered in **none** | 7 — `src/service.mjs`, `src/store.mjs`, `src/tui/api.mjs`, `src/tui/screens/tasks.mjs`, `web/api.mjs`, `web/components/form.mjs`, `web/views/tasks.mjs` |

Precision 27% on the stable set (4/15). Dead weight 40% (6/15). Recall 4/11 ≈ 36%
on the stable set; per-run recall@15 was 38–46%.

Three independent attempts produced the same four hits and the same six wastes.
This is a systematic signal, not sampling noise.

### 2.2 The ranker has no signal for this task, so it returns alphabetical order

Thirteen of the task's fifteen tokens have document frequency 0 across the
repo's 72 paths:

```
add 0   better 0   description 0   easy 0   field 0   input 0
instead 0   just 0   lines 0   make 0   need 0   the 0
new 1   task 2
```

The reconstructed scores:

```
score  components                        path
   15  name(task)+10, recency+5          src/tui/screens/task.mjs
   15  name(task)+10, recency+5          web/views/task-detail.mjs
   10  name(new)+10                      .idea/material_theme_project_new.xml
    8  entry+3, recency+5                src/cli.mjs
    8  entry+3, recency+5                src/server.mjs
    8  entry+3, recency+5                tests/server.mjs
    8  entry+3, recency+5                web/index.html
    6  entry+3, recency+3                src/tui/app.mjs
    6  entry+3, recency+3                web/app.mjs
    5  recency+5                         ← 59 more files, all identical
```

`git log -n 200` returned **67 entries for a 72-file repository**. 93% of the repo
is "recent", so 20 files get +5 and another 40 get +3 — a near-constant with zero
discriminative power, contributing 5 of the top 10's points.

Below the 8s sit 59 files tied at 5. Order within the tie comes from
`a.path.localeCompare(b.path)`: **alphabetical**. That is why the selection begins
`.gitignore`, `.idea/…`, `AUDIT-PLANNER-SPIRAL.md`, `PLAN-PLATFORM.md`,
`docs/ARCHITECTURE.md`, `package-lock.json`, then `src/…` in name order.

It is not a bad ranking. It is the absence of one.

### 2.3 The budget was never the binding constraint

Nine of the fifteen files were truncated at exactly 3009 tokens
(`fileChars: 12000` → 12000/4 + the truncation suffix). The context cost
32,039 tokens of a 50,000 budget and `trimmed: []` — **the trim ladder never ran.**
The harness was cutting nine files off mid-content while leaving 36% of the budget
unspent. The binding limits are `files: 15` and `fileChars: 12000`.

Raising `budget` would have changed nothing.

### 2.4 Are the seven misses recoverable?

**One hop of import expansion** from the four true positives reaches 3 of 7
(`src/service.mjs`, `web/api.mjs`, `web/components/form.mjs`) for a candidate pool
of 20 files out of 72. `src/store.mjs` is two hops; the two `tasks.mjs` files are
routed rather than imported, so they need in-edges.

**Document term frequency fails.** Every one of the seven needed files contains
task tokens (7/7, 38 hits). But so do five of the six wastes (5/6, 22 hits) —
including `AUDIT-PLANNER-SPIRAL.md`, which contains **9 of 12 task tokens and 60
occurrences of "task"**, more content evidence than any of the seven files the
planner needed. Plain TF would have ranked the doc above the form component.

**Symbol-level definition fan-out succeeds.** Counting identifiers that contain
each query word:

```
input        defined in  1 file   web/components/form.mjs  ['TextInput']   ← needed, ranked 48th
field        defined in  1 file   web/app.mjs              ['findSearchField']
description  defined in  0 files
task         defined in  7 files  ← over-defined; Aider's rule demotes this ×0.1
line         defined in  5 files
```

`input` resolves to exactly one file in the repository, and it is the file the task
is about. `task` and `line` are defined widely, and are precisely the tokens that
plain TF rewards in the prose docs.

The discriminator is not "how often does this document use the query's words". It
is **"which file declares the thing the query names."** Those are different
signals, and the second one is cheap.

**Built and measured — phase 4.** `declarations()` and `declaredBy()` in
`src/context.mjs`, shipping as `define: 12`. Three departures from the section
above, one of them a deletion:

1. **The scope filter is the column, not the file.** Aider gets "this is a
   declaration worth ranking" from tree-sitter's `is_important` scope. A regex has
   to decide for itself, and the decision is the difference between the mechanism
   working and not working: with every `const` counted, `input` resolved to two
   files instead of the one this section is built on, and `task` to thirteen
   instead of seven, on `const input = usage.inputTokens` and
   `const task = await store.task(id)`. Requiring the match to start the line —
   no leading whitespace — separates a declaration from a binding, and reproduces
   §2.4's table exactly where the unrestricted extractor does not. It is one
   character class standing in for a scope filter, and it is the load-bearing part
   of the design.

2. **The whole-identifier half was built, measured at zero, and removed.** This
   section asks for the identifier *and* its sub-tokens to be emitted, on both
   sides. Implemented faithfully — keyed in `defines`, emitted from the task text —
   it moved all four metrics by 0.000000. The reason is structural rather than a
   property of this corpus: `tokenize` splits camelCase before either side sees it,
   so the only whole multi-word forms a task text contains are words like `PLAN`,
   whose lowercase form is already a sub-token of the identifier. The sub-token key
   *is* the mechanism; the sentence about emitting the whole form did not survive
   contact, and the code does not carry it.

3. **Rust's `struct` and `impl` are not matched, but Python's `def` and Ruby's
   `class` are.** The distinction is not the language, it is reachability: `SOURCE_FILE`
   carries no `.rs`, so a Rust pattern could never fire on any repository, and a
   pattern that cannot fire is a pattern nothing tests. `.py` and `.rb` *are* in
   `SOURCE_FILE`, so those patterns fire on any repository containing them — this
   one contains neither, which makes them untested here rather than dead. §9
   records that.

Cost, measured rather than asserted: 8.8 ms against the graph's 7.0 ms, 15.1 ms
for the pair inside a 45.8 ms `relevantFiles`. The cost is the reads, not the
regexes — and it is a *second* pass over the source files, not a share of the
graph's, which the first draft of this section claimed and the timer contradicted.

**But fan-out's yield is narrow, and the table above is why.** Score it against the
seven misses rather than against the intuition:

| probed token | resolves to | misses reached |
|---|---|---|
| `input` | `web/components/form.mjs` | **1** |
| `field` | `web/app.mjs` — already offered at score 6 | 0 |
| `description` | nothing (defined in 0 files) | 0 |
| `task` | 7 files, over-defined, demoted ×0.1 | 0 |
| `line` | 5 files | 0 |

So definition fan-out reaches **1 of 7** misses, against **3 of 7** for one-hop
import expansion — and the graph is the cheaper mechanism of the two. Fan-out is
decisive where it fires and fires on a minority of tokens, because most task tokens
name no declaration at all. `description` names none; 13 of the 15 tokens have
`df = 0` across the paths.

The two signals are not alternatives. Fan-out is what finds the file the task is
*about* from a cold start, which the graph cannot do — an import edge needs a seed.
The graph is what finds the file *next to* what fan-out found. Neither reaches 7 of
7, and §5.14 names what reaches neither.

**Built and measured — phase 3.** One hop, both edge directions, over the import
graph of §5.2. Same process, same tree, `edge: 0` against the default:

| tree | | unoffered | recall@15 macro | micro | MRR | nDCG@15 |
|---|---|---|---|---|---|---|
| today | graph off | 22 | 0.691 | 0.600 | 0.644 | 0.559 |
| today | graph on | **20** | **0.744** | **0.636** | **0.657** | **0.581** |
| `066446e` | graph off | 31 | 0.531 | 0.436 | 0.612 | 0.512 |
| `066446e` | graph on | **20** | **0.746** | **0.636** | **0.701** | **0.554** |

Two things are worth more than the deltas. **The gain is diffuse**: leave-one-out
over all 14 gold-bearing runs is positive in every fold for recall and for nDCG,
so it is not one run carrying the mean. And **the graph is tree-insensitive where
the lexical pass is not** — the two trees start 16 points apart and the graph
lands them at 0.744 and 0.746, recovering 11 of the 13 extra unoffered files on
the older tree. Most of what the tree moves is files that have nothing to do with
the task; an import edge is evidence the task's own files can supply.

What it changes, per task, is legible rather than statistical: on the
`provider health` task it swaps `bin/install-ai-code`, `dev/ai-code` and
`web/index.html` for `src/service.mjs` and `src/store.mjs`, which is the two files
that task has to touch. On the reviewer-verdict task it drops three `PLAN-*.md`
documents. `web/api.mjs` — one of the three named misses above — comes back on the
form-component task that §2.1 is about.

**§5.2's literal `×50` is the one part of the design that measured worse than
doing nothing.** Swept over the weight, recall peaks at 3–5, decays from 6, and
crosses below the graph-disabled baseline by 20. The table's constant is an edge
weight in Aider's PageRank, where the mass is normalised across the graph; read as
a score multiplier it evicts the seeds it expands from and the window fills with
one seed's neighbours. Dividing by the seed's fan-out is likewise not optional:
undivided, *every* weight is worse than disabling the graph (macro recall 0.691 →
0.544). Both are recorded in §5.2.

**Built and measured — phase 4.** The declaration scan of §5.1, over the same 14
runs, same tree, same process. Each mechanism ablated against the other:

| | unoffered | recall@15 macro | micro | MRR | nDCG@15 |
|---|---|---|---|---|---|
| both off (§2.6 baseline) | 22 | 0.691 | 0.600 | 0.644 | 0.559 |
| graph only (phase 3) | 20 | 0.744 | 0.636 | 0.657 | 0.581 |
| symbol only (phase 4) | 19 | 0.773 | 0.655 | 0.644 | **0.620** |
| **both (shipped)** | **15** | **0.855** | **0.727** | **0.658** | 0.585 |

**The two mechanisms are superadditive on recall, which is the design's own claim
confirmed.** Graph alone is +5.3 points, symbol alone +8.2, and together +16.4 —
22% more than the sum of the parts, with unoffered files falling from 22 to 15
where the two halves predict 17. §5.1 said symbol retrieval is what the graph
cannot do from a cold start, "an import edge needs a seed, and this is what
supplies it"; the arithmetic says that is not a figure of speech. The fan-out hands
the graph seeds it otherwise never gets, and the graph then reaches the
neighbourhood of files that no lexical pass had any reason to look at.

**The target miss is recovered.** §2.4's decisive case — `input` resolving to
`web/components/form.mjs`, the file that task is about — was ranked 48th and
unoffered. It is now rank 6 of 16, and the fan-out is the only pass that put it
there: it shares no token with the task text and the graph had no seed for it.

**The trade is real and is not hidden in the mean.** Per run, 4 improved, 4
regressed, 6 unchanged. Every one of the four regressions is the same task —
"Improve the Mission Control task detail view so PLAN, EXECUTE, REVIEW…" — whose
gold set is 16 to 27 files out of 53. A task whose answer is most of the
repository is one where any reordering costs, and the fan-out reorders: `plan`,
`review`, `activity` and `api` are all declared widely, so the pass pulls a crowd.
Recall on its four runs falls 0.18→0.05, 0.25→0.06, 0.21→0.05 and 0.40→0.32. The
gains are larger and elsewhere: 0.46→0.64 and 0.60→0.67 on the two `input` runs,
0.50→0.75 and 0.50→1.00 on the two `cleanup mechanism` runs. Leave-one-out over
all 14 runs is positive in every fold, worst +6.2 points — including every fold
that drops one of the regressing runs, which is the check that says the mean is
not being carried by a single task in either direction.

**The divisor is the whole of the normalisation, and the variant that measured
highest was rejected.** The pull a name generates is divided across the files that
declare it, and the exponent decides how hard:

| divisor on the declaring-file count | macro | micro | nDCG@15 | unoffered | leave-one-out worst fold | worst single run |
|---|---|---|---|---|---|---|
| none | **0.873** | **0.764** | **0.605** | **13** | +8.3 | **0.000** |
| `1/sqrt(n)` | 0.855 | 0.727 | 0.585 | 15 | +6.2 | 0.045 |
| `1/n` | 0.855 | 0.727 | 0.587 | 15 | +6.2 | — |

Undivided wins every column but the last, and the last is why it is not shipped.
On a task whose tokens are all common vocabulary — `plan`, `review`, `activity`,
`api`, `view`, `detail` — an undivided pull fills all fifteen slots with files
that merely declare those words. Measured on three Mission Control runs: 0.182 →
**0.000**, 0.250 → **0.000**, 0.211 → **0.000**, with none of 22 gold files
offered and every slot taken by a fan-out file. `1/sqrt(n)` leaves the same three
runs at 0.045, 0.063 and 0.053.

A macro mean cannot express the difference between 0.05 and 0.00 — both round to
nothing — but a ranker that hands back an empty-relevant window has failed
categorically rather than marginally, and one constant buys its absence back.
**§5.3's rule predicted this exact failure and the headline metric said to ignore
it.** The per-run floor is what caught it, which is why this phase reports per-run
deltas beside the mean and why §9 keeps the argument open.

`1/n` and `1/sqrt(n)` are indistinguishable where both peak — 0.855 each — and it
is their agreement, rather than either one's number, that says the flattening is
doing the work. Shipped at 12, the middle of a plateau that runs 6 to 20 with the
cliff at 25.

### 2.5 The tokenizer discards the tokens that discriminate

`tokenize()` at `src/context.mjs:200`. Run on identifiers, before and after the
phase-1 fix:

```
identifier           before the fix           after the phase-1 fix
HTTPServer           ["httpserver"]           ["http","server"]
parseHTMLResponse    ["parse","htmlresponse"] ["parse","html","response"]
IOError              ["ioerror"]              ["error"]
getUserID            ["get","user"]           ["get","user"]
URLParser            ["urlparser"]            ["url","parser"]
base64               ["base"]                 ["base"]
XMLHttpRequest       ["xmlhttp","request"]    ["xml","http","request"]
```

The camel boundary `(?<=[a-z0-9])(?=[A-Z])` requires a lowercase→uppercase edge, so
an acronym run followed by a capitalised word never splits: `HTTPServer` is one
token. The fix, now landed, is a second alternative,
`(?<=[A-Z])(?=[A-Z][a-z])`, ordered after the first so it fires only where the
camel rule did not. Three rows are still short after it, and the remaining defect is
no longer the split: `IOError` recovers `io` and loses it to the `< 3` rule, and
`base64` still loses `64` to it. `base64` is the third defect —
`(?<=[a-z])(?=[0-9])` splits the letter→digit edge and the floor then deletes the
numeric half. That is why the floor did not ship with the split; see §5.3 and §8.

That floor is the more damaging of the two. What survives it is a list of the
words that appear in every task description:

```
dropped  ui db io os js id fs ci ip v1 2d
kept     get set new the and for use has add run src lib app doc api mod
```

It deletes two-letter vocabulary (`ui`, `db`, `io`, `js`, `id`) and keeps filler
(`the`, `add`, `new`, `get`, `set`), each of which then scores `+10` per basename
hit. On the failing title the surviving tokens are `need make the task description
input better easy add new lines instead just field`, of which **`the`, `add` and
`new` are filler carrying a +10 path bonus**.

`.idea/material_theme_project_new.xml` earned rank 3 on `new` — a token that
cleared the floor, appears in the task, and has `df = 1` across the 72 paths, so
its IDF is 3.88, which is *high*. IDF would not have removed this file. Rank 3
came from the absence of a file-type gate, not from a weak IDF (§5.3, §5.13).

### 2.6 The corpus baseline, and why §2.1 is not it

§2.1 is one task under a loose gold definition. The harness of §5.12 is the
corpus, under a pinned one. They are not comparable and should not be quoted
together; §2.1 remains the case study that motivated the work.

**The table first written here does not reproduce, and that is the finding.** It
read `0.772` macro and 18 unoffered "after phase 1". Re-run against the tree of
`066446e` — the commit that carries it — the same code measures `0.531` and 31.
Against today's working tree, `0.691` and 22. Neither is `0.772`, and a stray file
in the working tree at measurement time does not account for the gap either. It is
recorded as unreproducible rather than quietly replaced with a number that is.

The cause is structural rather than an arithmetic slip: `evaluate()` re-ranks
against **the tree on disk**, so every figure here is a property of *(ranker,
tree)* and not of the ranker. Adding one file to the repository moves the baseline.

22 planner runs, 14 with a recoverable gold set, in two tree states. Both columns
are the ranker as it was before phase 3:

| | `066446e`'s tree | today's tree |
|---|---|---|
| usable runs | 14 | 14 |
| runs with **no** gold (died before reading anything) | 8 | 8 |
| runs whose gold exceeds the window, recall capped at `k/|gold|` | 5 | 5 |
| answers across the uncapped runs | 55 | 55 |
| **answers the ranking never offered** | **31 (56%)** | **22 (40%)** |
| recall@15, macro | 0.531 | 0.691 |
| recall@15, micro | 0.436 | 0.600 |
| MRR | 0.612 | 0.644 |
| nDCG@15 | 0.512 | 0.559 |

The sixteen-point spread between the columns is the tree alone — larger than
anything phases 3–7 have produced so far, and enough on its own to explain the
unreproducible row above. **A before/after comparison is therefore only valid
within one tree state**: run `ai-code eval`, change the ranker, run it again,
committing nothing in between. Across commits this measures the repository as
much as the code. Every phase-3 number in §2.4 is same-process and same-tree.

The unoffered rate is the number that corroborates §2.1 and the only one of these
the ranker is unambiguously responsible for: a gold file that was offered *and*
then read is partly a fact about the prompt, because a planner reads what it is
handed. §2.1 found 7 of 11 misses on its single task; the corpus rate is 22 of 55
on today's tree. Same direction, and the case study was an unusually bad task
rather than a typical one.

**The macro/micro gap of ten points is a warning about quoting either alone.**
Nine runs carry the macro number and four of them have a gold set of three files
or fewer, so a run that read one file weighs as much as a run that read fifteen.

`|gold|` is not small. Distribution over the 14 usable runs:

```
 1:2   2:1   3:1   4:2   11:1  14:1  15:1  16:1  19:1  22:1  25:1  27:1
```

Six runs have a gold set of four files or fewer, which is a benchmark item that
cannot discriminate: offering four files and finding all four is not evidence of
anything. And two of the six tasks carry eight of the fourteen usable runs —
`d25abe5b` was planned seven times and `53da01a5` four — so the corpus holds
rather fewer independent judgments than its run count suggests, and all five
capped runs come from the one task.

**What this means for the phases ahead.** The corpus is large enough to detect a
change of the size phase 3 and 4 promise — twenty-odd misses is a real target —
and far too small to fit parameters against, which is why §5.13's weights stay in
the last phase. It also means the honest headline for phase 3 is *misses
recovered*, not a delta in mean recall: those are small enough to inspect one at a
time, and §2.4 does.

---

## 3. Requirements

| # | Requirement | Current state |
|---|---|---|
| R1 | Rank by evidence that discriminates | Flat additive score; recency contributes to 68 of 68 scored files |
| R2 | Retrieve the change *surface*, not just the names the task utters | Path-only; the 7 misses are unreachable by any path token |
| R3 | Bound false positives in the selected set | No precision guard; 40% dead weight |
| R4 | Honour the budget as a hard cap | `while (total > budget && files.length > 1)` exits at one file and sends the overflow anyway |
| R5 | Derive the budget from the routed model's window | `budget: 50000` absolute; the guard at `src/service.mjs:1685` throws below ~59k |
| R6 | Byte-identical output for identical input | `a.path.localeCompare(b.path)` is ICU-locale-dependent |
| R7 | Bounded time, on the critical path | Full sync walk, twice |
| R8 | Bounded memory and I/O | `walk()` materialises every path, twice |
| R9 | Never throws | **Violated** — EACCES in `walk()` propagates out of the run (§4) |
| R10 | Total generality | Any language, no git, no manifest, 10 files or 500k |
| R11 | Reconstructible selection | Nothing persisted beyond counts |
| R12 | Named degradation states with a recovery path | Silent best-effort |
| R13 | Reject structurally-irrelevant files before scoring | ~~No file-type gate~~ **Phase 1** — `NOISE_FILE` excludes lockfiles, minified bundles and sourcemaps from scoring; they stay in the tree |
| R14 | Scores comparable across queries | Raw sums; `normScore = score / Σ idf` is the fix (§5.13) |
| R15 | Never serve a stale index | No cache |
| R16 | Every signal self-normalising | Recency is 93% coverage and 5 of the top 10's points |
| R17 | Tokenise identifiers the way the language does | Acronym runs collapse, then the <3 floor deletes the halves (§2.5) |
| R18 | Filler terms carry no weight | `the`, `add`, `new` score `+10` per basename hit |

---

## 4. Non-happy paths

Verified against source unless noted.

| Condition | Required | Today |
|---|---|---|
| **Unreadable subdirectory (EACCES)** | Skip, continue | ~~**Throws out of `inspect()` → out of the run.** Verified: `THREW: EACCES ... scandir '/tmp/walktest/locked'`. `walk()` at `src/context.mjs:38` has no try/catch~~ **Fixed in phase 1** — the walk records the directory in `manifest.unreadable` and continues |
| **One file exceeds the budget** | Emit path only | ~~**Sends over-budget context** — ladder exits at `files.length === 1`~~ **Fixed in phase 1** — unconditional rungs reduce content to paths, then the tree |
| Empty repo | Return empty, marked | `paths: []`, unlabelled |
| No git history | Recency contributes nothing | Handled — `recentFiles()` catches |
| Task text with no usable tokens | Widen, mark weak | `tokenize()` drops <3-char tokens; `ui`, `db`, `os`, `js`, `id` vanish silently (§2.5) |
| Acronym run in a task token | Correct split | ~~`HTTPServer` → `httpserver`~~ **Fixed in phase 1** — → `["http","server"]`. `base64` → `["base"]` remains: that half is the floor, not the split (§2.5) |
| Task token is filler (`the`, `add`, `new`) | Weighted to ~0 | `+10` per basename hit, same as a rare token |
| Zero files score > 0 | Labelled default | `ENTRY_POINT`/`CONFIG_FILE` usually prevent literal zero, so the degenerate case is *entry points only*, unlabelled |
| All candidates tie | Deterministic order | `localeCompare` — locale-sensitive |
| Binary / >2 MB file | Path only | Handled, silently |
| Symlinked directory | Follow or report | `Dirent.isDirectory()` is false for a symlink → pushed as a file, never recursed |
| Filename containing a newline | Correct parsing | `git log --name-only` split on `\n` yields garbage entries |
| Monorepo, 200k files | Bounded work | Full sync walk ×2; `tree: 400` is an alphabetical prefix, so anything past the 400th path is undiscoverable |
| Task vocabulary ∌ code vocabulary | Mark low confidence | Returns entry points + configs + recent as though it had matched — this is §2.2 |
| Model window < ~59k | Shrink, or reroute to a wider window | Hard `CONTEXT_TOO_LARGE`; the next candidate likely shares the window |
| `contextLength` absent | Assume a safe floor | Guard skipped entirely |
| Vendored / generated / lockfiles | Never spend a slot | ~~`ignored` has 12 names~~ **Fixed in phase 1** — 28 directory names, plus `NOISE_FILE` for lockfiles, `*.min.{js,cjs,mjs,css}` and `*.map`, which leave the *scoring* pass but stay in the tree |
| Planner at root, implementer in worktree | Stated invariant | Both re-rank different trees; the gate uses the planner's set. Divergence is by design but undocumented |
| Import specifier is an alias, a glob or built at runtime | Resolve, or draw no edge | **Phase 3** — only relative and Python-dotted specifiers resolve; `@/lib/x` and a computed path draw nothing and contribute no frontier. Degrades to the pre-phase-3 ranking rather than throwing |
| Import scan reads a file it cannot open | Skip, continue | **Phase 3** — `readText()` returns null and the file contributes no edges; a binary read as UTF-8 is rejected on its NUL |
| Declaration scan reads a file it cannot open | Skip, continue | **Phase 4** — the same `readText()` guard and the same NUL rejection, so the two scans degrade identically and a file neither can read is ranked on its path alone |
| A file declares nothing | Contribute nothing, stay rankable | **Phase 4** — a declaration only ever *adds* pull, so a file with no declarations is ranked exactly as before. A config, a doc and a stylesheet are all in this class and none is made worse by the pass |
| A declaration regex fires on a comment or a string | Contribute a low-weight edge | **Phase 4** — accepted. `define: 12` divided by the fan-out makes a false positive worth a fraction of a real one, and §2.4's measured effect is +11.1 macro recall against it. §9 records that neither error direction is measured |
| The same name is declared in many files | Speak with less than a name one file declares | **Phase 4** — the pull divides by `sqrt(n)`, not by `n`: measured, `1/n` is too blunt to reorder the mid-field and its plateau ends in a cliff. A file declaring a name that is *only* declared alongside ten others is not distinguished from them, which is correct and was the first thing the test for this asserted wrongly |

---

## 5. Design

### 5.1 Change the unit of retrieval from the file to the symbol

This is the finding in §2.4, and it is the whole design. Aider's repo map does
exactly this. It builds `defines[ident] -> set(files)` and
`references[ident] -> list(files)` from tree-sitter tags, ranks
`ranked_definitions[(fname, ident)]` — *symbols* — and groups them into files only
at render time. CodeRAG-Bench independently found pre-retrieval chunking
transforms repository context (GitHub source: 3.7 → 29.3 at N=500) while
reranking *inside* the 200–800 token band degraded results.

For a repository this size, tree-sitter is unnecessary. A per-language regex for
declarations (`function|const|let|var|class|def|interface|type|struct|impl`)
recovers the def side at ~1% of the complexity, and §2.4 shows it already resolves
the decisive query. A false positive costs a low-weight edge, not a wrong answer.

**Emit the whole identifier as a token *and* its sub-tokens.** `buildTaskContext`
produces `buildtaskcontext` alongside `build`, `task`, `context`. The whole form is
near-unique across a repository, so an exact-name query gets a high-idf term that
matches only the declaring file — the strongest single signal available, and it
costs nothing but vocabulary growth. Identifier-aware tokenization applied at both
index and query time is also the one intervention with direct published evidence
behind it: under generic tokenization BM25 can rank the gold file below distractors
that merely share rare identifier sub-tokens, and adding the sub-tokens is reported
to make BM25 carry the discriminative signal on its own (arXiv:2605.18561 — a
preprint, not peer-reviewed; see §9).

### 5.2 Score multiplicatively, not additively

Aider's edge weights compound. The portable set, with the reason for each:

| Rule | Effect | Why it matters here |
|---|---|---|
| mentioned in the task text | ×10 | `input` → the one file that declares it |
| long snake/kebab/camel identifier (≥8 chars) | ×10 | proxies "this name carries meaning" |
| leading underscore (private) | ×0.1 | privacy convention as a relevance signal |
| **defined in >5 files** | ~~×0.1~~ → `1/sqrt(n)`, continuous | demotes `task` (7) and `line` (5) — the ambiguous tokens |
| referenced *from an already-selected file* | ~~×50~~ **×3** | the dominant term; turns global popularity into frontier expansion |
| reference count | `sqrt(n)` | a file that says `logger` 200× must not swamp a rare domain symbol |

Additive scoring cannot produce this spread from the same signals, and the spread
is what makes a top-k cut stable.

These weights multiply along **graph edges**, not term frequencies inside a
similarity function. §5.13's BM25F field weights are a separate mechanism and are
capped at `1 + k1 = 2.2×`; the ×10 and ×50 above are not available there. The two
compose — BM25F orders candidates, the graph re-weights them.

**Measured in phase 3, and two of the three consequences are the opposite of what
this section assumed.** The frontier ships; the constants do not survive contact.

1. **`×50` is worse than no graph.** It is an edge weight in a PageRank, where the
   mass is normalised across the graph and a large weight redistributes rather than
   scales. Read as a score multiplier — which is what the table above invites — it
   evicts the seeds it expands from: a seed scoring 15 hands each of its imports
   750, and the window becomes that seed's import list. Swept over the corpus,
   macro recall peaks at 3–5, decays from 6, and crosses below the
   graph-disabled baseline by 20. Shipped at 3, where the pull is worth about one
   lexical hit.
2. **`sqrt(n)` is not enough normalisation.** The reference-count term is applied to
   the edge's *source* as an outright divisor on the seed's fan-out, and `1 + n`
   beat `1 + sqrt(n)` by three points of macro recall. Undivided, every weight is
   worse than disabling the graph entirely (0.691 → 0.544): nine of
   `web/views/task-detail.mjs`'s imports beat two of `src/server.mjs`'s purely on
   that seed's size. This is §5.3's rule, not a new one — a signal's weight has to
   fall as its coverage rises — and the measured size of the effect says the
   normalisation is the load-bearing half of the design, not the multiplier.
3. **The pull is bounded by the seed's own score**, so a pull a seed generates
   cannot evict the seed that generated it. This one held.

The generalisable finding: on this corpus the value is in *breaking the alphabetical
tie toward adjacency*, not in a dominant term. §2.2's failure was 59 files tied at
an identical score; a pull of a few points settles that, and 750 does not — it
replaces one arbitrary order with another.

**Measured in phase 4, and the same rule decides the fan-out's exponent.** The
`>5 files → ×0.1` row above is the threshold form of a rule that does not want a
threshold in it; the shipped form is `1/sqrt(n)` applied to every value of `n`,
which is the same demotion with the step taken out, and the table's own `sqrt(n)`
row is where the exponent came from. The three candidate divisors were measured
against each other and they are not close:

| divisor on the declaring-file count | macro recall | micro | nDCG | unoffered | shape of the sweep |
|---|---|---|---|---|---|
| none | **0.873** | **0.764** | **0.605** | **13** | 0.826 at 6–15, then 0.873 at 20–40, then 0.848 at 60 |
| `1/n` | 0.855 | 0.727 | 0.587 | 15 | flat 10–25, 0.797 at 30 |
| `1/sqrt(n)` | 0.855 | 0.727 | 0.585 | 15 | flat 6–20, 0.814 at 25 |
| inverse-document-frequency | 0.848 | 0.709 | **0.591** | 16 | flat, lower recall at every weight |

**The rule held for the edge and did not hold for the token, and that is the
finding.** Undivided is the best variant on the mean by a wide margin — better
macro, micro, nDCG, unoffered and leave-one-out floor than any divisor — and it is
rejected because of a per-run failure the mean cannot show: on three of the Mission
Control runs it fills all fifteen slots with files that merely declare the task's
common vocabulary and returns **zero** of 22 gold files. §2.4 has the table.

The asymmetry with the graph edge has a reason, and the reason is why this is not a
contradiction of §5.3 but a boundary on it. A hub file's degree says a great deal
about how much of a seed's pull is signal: nine imports from one file is a
different kind of evidence from one. A token's document frequency says very little
about whether the *task* is about that token — `plan` and `review` are declared
widely because that is what the product is about, and their width is not evidence
against the task naming them. So the edge needs the divisor and the token does not
on the evidence, while the token needs it anyway on the failure mode. Both land on
`sqrt`, for different reasons, and §9 keeps the disagreement.

IDF is recorded because it is the principled form and it wins nDCG; it is not
shipped because it loses macro recall at every weight tried.

### 5.3 Every signal must be self-normalising

The recency bonus is the cautionary case: 93% coverage, zero information, 5 of
the top 10's points. Any signal needs a weight proportional to
`1 − coverage`. In practice:

- a path token's weight ∝ its IDF
- the entry-point bonus is suppressed when many files match the pattern
  (here `tests/server.mjs` and `web/index.html` entered the top 8 on it,
  across three different directories)
- recency's weight ∝ the fraction of the repo that is *not* recent

Concretely, in this order:

1. Split identifiers correctly (`(?<=[A-Z])(?=[A-Z][a-z])`), then lowercase.
   **Landed in phase 1**, alone, because it is the only step here with no partner.
2. Lower the floor to 2 characters. Not before step 3 — and this is why the floor
   did not ship in phase 1 either. Steps 2 and 3 are one change, not two.
3. Weight each token `1 / (1 + df(token))` over the path list `inspect(root)`
   already returns. This is most of the stoplist for free: `the` is damped by its
   document frequency rather than by being enumerated, and `ui` survives.
4. **No stoplist.** IDF already discounts common terms monotonically, and a
   stoplist deletes tokens that are real signal in code — `in`, `is`, `to`, `as`,
   `id`, `of` all appear inside identifiers. Use Lucene's strictly-positive IDF
   (never negative above `df = N/2`, so no flooring is needed) and drop the list.
   Handle the genuinely uninformative query by measuring `Σ idf` instead (§5.7).
5. **No stemming.** Naive identifier splitting was measured to *reduce* identifier
   MRR by 5.68% (arXiv 2201.01988). `classify` and `classification` are one token
   apart in a vocabulary of this size, and merging them costs precision the
   fan-out penalty then has to buy back.

The ordering constraint is the point: the floor is what deletes `ui`, and the df
weight is what damps `the`. Applying the floor first at `< 3` needs a hand-written
list of every two-letter identifier a project might use; lowering it and letting
`df` do the work does not.

### 5.4 Rank hierarchically

Agentless localises file → function → line, each stage narrowing; its file-level
top-5 ceiling is 93.6%, and at ~80% top-1 file accuracy end-to-end resolution is
still ~38% — file localisation is necessary but not sufficient. Windsurf's Fast
Context and Sourcegraph both converge on **files plus line ranges** as the output
shape, which is also the shape that makes the output verifiable.

### 5.5 Render hierarchy, not whole bodies

The current assembler inlines up to 12 KB per file and truncated nine of fifteen.
Aider renders a file header plus selected definition lines with `⋮...` elisions
and 100-character line truncation, giving the model the API surface and enough
structure to ask for more. This is the largest token-efficiency lever available
and it is pure string formatting.

### 5.6 Budget from the window

`budget = min(cap, floor(window × 0.85) − reserve_output − measured_fixed_sections)`.
Aider derives this too: `clamp(max_input_tokens / 8, 1024, 4096)`, warning when a
user asks for more than 2× that.

The shrink ladder must be **total** — content → conventions → architecture → tree →
files-to-paths-only → unconditional clamp — so that over-budget is
unrepresentable. Today the ladder has a floor at one file and no clamp.

### 5.7 Two decisions, not one threshold: no-results and weak-results

Two independent measurements say a ranker that always returns top-k is worse than
one that can decline. CodeGrep found BM25 retrieval **harmed** agent performance at
precision 0.375, was neutral at 0.445, and only helped above ~0.677. Repoformer
measured ~20% of retrievals helping and ~20% actively harming. Aider's ranker
returns `[]` outright on PageRank failure.

The measured precision here is 27% — inside the zone where retrieval is net-negative.

Production systems split this in two, because one score threshold cannot do both
jobs. **"Nothing matched" is a coverage decision; "matched badly" is a
distributional decision.**

**Coverage — no results.** Boolean, not a score. Elasticsearch expresses it as
`minimum_should_match`, a graduated ladder rather than a threshold; SQLite FTS5
retries a zero-result query with the terms OR-joined, and that retry is strictly
additive — it fires only on a zero-result miss and never reorders existing hits.
Adopt the FTS5 shape:

```
if coverage_max == 0:              # no query term present in any file
    relax once (OR the terms, or drop the lowest-idf term) and re-run
    if still empty → NO_RESULTS; fall back to entry points + config + recency
```

**Strength — weak results.** The signal is not the top score but the *dispersion*
of the top-k scores. Normalized Query Commitment (Shtok, Kurland, Carmel et al.,
TOIS 2012) is the standard predictor: spread-out top scores mean the query found
something specific, tightly clustered scores mean it did not, however high the top
one happens to be.

```
NQC(q) = sqrt( (1/k)·Σ_{d∈top-k}(score(d) − μ̂)² ) / score(D)     μ̂ = mean of top-k, k = 100
```

Dispersion catches what an absolute threshold cannot. §2.2's failure was 59 files
tied at an identical score, with the ordering decided by `localeCompare` — a high
top score with no spread is not a good result set.

```
if Σ_{t∈q∩V} idf(t) < QUERY_IDF_FLOOR:   # uninformative: stopword-only, or one common term
    → low confidence; return the static default set, labelled
if max(normScore) < NO_MATCH_FLOOR or NQC ≈ 0:
    → weak; relax once, then return labelled low confidence rather than empty
```

Calibrate `NO_MATCH_FLOOR` from the §5.12 harness: dump `normScore` for the gold
files against the rest and take the floor where precision starts to fall. Start at
0.25 and expect 0.2–0.4. `QUERY_IDF_FLOOR` is corpus-size dependent — set it as a
percentile of the per-term idf distribution, e.g. the idf of a term with `df = 0.3N`.

**One-token queries must not be thresholded.** With a single term, `idf` is a
constant across documents and so does not affect the order at all: the ranking
rests entirely on field weights and length, and there is no coverage signal to
measure. Return a longer list ordered by field-weighted evidence and let the
assembler truncate.

Expose the branch that ran and how many terms were dropped, as FTS5 does. A tool
that silently degrades is worse than one that says "nothing matched `foobar`, here
are the entry points" — and a labelled weak set beats an empty list.

### 5.8 Degrade, never throw

Aider's failure catalogue resolves entirely to *less context*: unparseable file
contributes zero tags, missing file warns once and skips, no references falls back
to definitions-as-references, corrupt cache rebuilds in memory, PageRank failure
returns `[]`. A context ranker is an optimisation on top of a working agent; an
exception from it must never be fatal.

The EACCES crash in §4 is the counter-example, and it is live.

### 5.9 Degradation states

| State | Condition | Prompt carries |
|---|---|---|
| `FULL` | Scored with discriminating signal | — |
| `PARTIAL` | Walk or index incomplete | the incomplete note |
| `DEGRADED` | Heuristic floor only (entry points + configs + recent), low confidence | an explicit "this is a listing, search for more" |
| `WEAK` | Scored, but `NQC ≈ 0` or top `normScore` below the floor (§5.7) | the results, labelled low confidence, with the relax count |
| `NO_RESULTS` | Coverage zero after one relaxation | tree only, plus the terms that matched nothing |
| `EMPTY` | Nothing scored at all | tree only |
| `FAILED` | Ranker threw | tree only, error recorded on the run |

### 5.10 Observability

Persist a debug record behind a config flag: per candidate
`{path, score, normScore, components, accepted, reason}`, plus `ceil(q)`, `NQC`,
the branch that ran, the config hash, tree hash, and timings. A few KB per run.
`normScore` and `ceil(q)` are the calibration inputs §5.7 needs; without them the
floor cannot be tuned. Without any of it the next regression is diagnosed the way
this one was — by reading a transcript.

### 5.11 Determinism

Codepoint comparison instead of `localeCompare`. Explicit total order
`(score desc, path asc)`. Never iterate a `Map`/`Set` built from filesystem order.
Fixed accumulation order for float sums.

### 5.12 Evaluation — the gold set already exists

Every `tool_use` read is in `events`, and `toolPaths()` at `src/service.mjs:62`
already extracts exactly that. So:

```
gold(task)   = files the planner actually opened
ranked(task) = relevantFiles(task).paths
metric       = recall@15, MRR, nDCG@15
```

Joining `runs` to `events` yields a labelled, project-specific retrieval benchmark
with no annotation work. The failure in §2.1 is precisely a recall@15 miss.

Build this **before** changing the scorer, so each change is provable and
reversible.

**Built — `src/ranker-eval.mjs`, `ai-code eval`.** The paragraph above turned out
to be under-specified in four ways that each change the number, and building it
is what surfaced them:

1. **Gold is a read, not a search.** §2.1 above counts `Read`/`Grep`/`Glob`
   together. Grep and Glob name a directory or a search root far more often than
   an answer — `tests` appears in this repository's own gold set as a Glob
   argument — so the harness counts `Read`/`NotebookRead` only. Under the loose
   definition the same corpus scores 0.568 mean recall instead of 0.633, and the
   difference is entirely files that were searched rather than read.
2. **The unit is a run, not a task.** §2.1 pools one task's four attempts into a
   single gold set of 11 files, which is why its recall is 36% where the per-run
   figure for the same task is 46–71%. Pooling makes the answer set larger than
   the window and the number a measure of the window.
3. **Paths need normalising across three shapes**, all present in this database:
   project-relative, absolute in the project, and absolute inside a per-task
   worktree (`\.ai-code-worktrees-<project>/<uuid>/…`). The third names the same
   file as the first; left as-is it both inflates the gold set and invents misses.
   `readPaths()` at `src/service.mjs:49` already drops these, because the
   normalised form starts with `..` — correct for the gate, whose root is the
   project, and invisible there because the gate only ever reads the planner's
   own run.
4. **A gold set larger than the window caps recall at `k/|gold|`**, however good
   the ranking is. Five of the fourteen usable runs here are in that state. They
   are reported and held out of the recall mean rather than averaged in as if the
   shortfall were the ranker's.

Two more things the paragraph above did not anticipate. Recall has two defensible
definitions that differ by nine points on this corpus, so both are reported:
**macro** (mean of per-run recalls, which lets a run with one answer weigh as much
as a run with twenty-seven) and **micro** (answers found over answers asked). And
eight of the twenty-two planner runs have no recoverable gold at all — a run that
died before opening anything is a case the benchmark silently drops, so it is
counted as `empty` rather than passed over.

**The published ceiling for this exact task is not high.** BugLocator (ICSE 2012)
is the closest analogue — rank source files against a natural-language bug report.
On Eclipse 3.1 (12,863 files) the file that needed changing landed in the top 10
for **62.6%** of bugs, and its gains came from priors over previously-fixed bugs,
not from the retrieval structure. Treat ~60% top-10 as the realistic target for a
file-level ranker and measure against the baseline rather than against 100%.

### 5.13 If content is scored, score it with BM25F — and normalise it

A content tier is the fix for R2. The formula is BM25F (Robertson, Zaragoza &
Taylor, CIKM 2004), not BM25, and not summed per-field BM25:

```
rejected: bm25(content) + 2.5·bm25(symbols) + 5·bm25(filenames)
```

Summing per-field scores is wrong because each term saturates independently, so a
document matching two fields outranks one matching a single field far better.
Weight the **term frequencies** first, then saturate once:

```
tf̃(t,d)  = Σ_f w_f · tf(t, d_f) / B_f
B_f      = (1 − b_f) + b_f · len_f(d) / avglen_f

score(d) = Σ_t idf_L(t) · (k1+1)·tf̃(t,d) / (k1 + tf̃(t,d))
idf_L(t) = log(1 + (N − df(t) + 0.5) / (df(t) + 0.5))        ← Lucene's variant
```

| field | w | b |
|---|---|---|
| basename, path segments, declared symbols | 5 | 0 |
| contents | 1 | 0.75 |

**One weight, not four.** The temptation is a per-field grid — basename 6, symbols
3, path 2 — and it buys less than it costs. Sourcegraph picked their `5` from "a
tiny grid" and reported that "the ranking was not too sensitive to the exact choice
of boost." Four weights are four parameters to tune against a gold set that does
not exist yet (§5.12), and every one of them is a place for the next reader to
disagree without evidence. Split them only if the harness shows one field is
specifically mis-weighted.

**`b = 0` on the path fields is the correction that matters.** Length
normalisation belongs only where length itself varies meaningfully; a one-segment
path and a six-segment path are not documents of different length in the sense `b`
models. Sourcegraph's shipped constants are the same shape — `w = 5` on
filename-or-symbol, `1` on content, `k1 = 1.2`, `b = 0.75`, plus a 5× *penalty* for
test/vendored/generated matches — measured at ~20% improvement across all key
metrics. Their `5` came from a small grid search, and they report the ranking is
not sensitive to the exact choice.

**The leverage is capped, and that constrains the design.** Under tf-combination
the lift from weight `w` over a content hit is `w(1+k1)/(w+k1)`: at `k1 = 1.2`,
`w = 5` → 1.77×, `w = 6` → 1.83×, and `w → ∞` asymptotes at `1 + k1 = 2.2×`. A
filename hit **cannot** be made to count 10× a content hit inside BM25F. §5.2's
×10/×50 rules are therefore a different mechanism, not this one: they are edge
weights in a dependency graph, multiplied along a path, never saturated. Do not
expect the content scorer to reproduce them. If the harness shows more than ~2× is
needed, apply a **bounded multiplier to the final score** (boosts apply outside
saturation) and keep it in the prior bucket.

**Normalise by the attainable score.** Raw BM25 is comparable only within one
query. This is what R14 asks for and what §5.7's gate needs:

```
ceil(q)      = Σ_{t ∈ q ∩ V} idf_L(t)                V = in-vocabulary terms only
normScore(d) = score(d) / ceil(q)    ∈ [0,1)         a per-query constant: ranking is unchanged
```

`normScore` is the idf-weighted mean of per-term saturation, and it decomposes into
the two questions §5.7 must answer: **coverage × strength**.

The `V` restriction is not cosmetic. Under Lucene's IDF an out-of-vocabulary term
gets the *largest* value in the collection — `log(2N+2)` at `df = 0` against
`log(N/1.5)` at `df = 1` — so including absent terms in the denominator crushes a
score by more than any real term contributes. Thirteen of the failing task's
fifteen tokens have `df = 0` across this repo's paths; normalising naively here
would be catastrophic.

Three further caveats:

- **`b = 0.75` on contents is still a prose constant.** In a repository, length
  correlates with being generated or vendored, so unmodified content-length
  normalisation lets a 3009-token `package-lock.json` out-score a 40-line
  component on repetition — the §2.3 failure by another mechanism. Test a lower
  `b_content` against the gold set.
- **IDF's fate is a measurement, not a principle.** Sourcegraph deleted it (zoekt
  #912) because corpus-frequency penalisation down-weights exactly the keywords a
  keyword-shaped query cares about. Lucene's strictly-positive form (above) is the
  safe default — it cannot go negative the way RSJ IDF does above `df = N/2`, so it
  needs no flooring — but test removal against the §5.12 gold set rather than
  assuming either way.
- **BM25+ is not a free upgrade.** Adding the constant `δ` bounds length
  normalisation, which helps when file sizes span three orders of magnitude — but
  `δ` is also a presence bonus that compresses field-weight effects, so it gives
  back part of what the field weights bought. Add it only if the harness shows
  long-file under-ranking.

This does not contradict §2.4's finding that plain TF fails, but it does not
settle it either. `AUDIT-PLANNER-SPIRAL.md` beats the component on raw term count;
under this formula the doc takes `w = 1` on every term while the component takes
`w = 3` for `input` through the `TextInput` declaration it carries. Whether field
weighting is enough to flip the order is a question for the §5.12 gold set — which
is why §8 puts the harness before the scorer.

### 5.14 The ceiling: files with no lexical or graph relationship to each other

The ranker is a **local** method. Every signal in it starts either from something
the task text shares with a file, or from a file already selected. A task like "add
authentication to the API" that spans three subsystems with no imports between
them, and no token naming any of them, is outside that reach — no seed, so the
graph has nothing to expand from; no declaration, so fan-out has nothing to point
at. At that point no scoring function helps, because the candidate never enters the
pool.

Three consequences, none of which is "build a better ranker":

- **Name it in the prompt.** This is what §5.7's `NO_RESULTS` and `WEAK` states are
  for. An agent told "here is a listing, none of your terms matched" goes and
  searches. An agent handed entry points with no label assumes it has been given the
  answer, which is §2.2's failure with a different cause.
- **Widen rather than deepen.** For a task with little lexical signal the useful
  output is more *names*, not better-ranked content. A paths-only list at 3–5× the
  normal `k` costs almost nothing and tells the agent which subsystems exist — 72
  bare paths is a rounding error in a prompt, and the model can pick from them.
- **Accept it.** BugLocator's 62.6% top-10 is measured on single-file fixes, and
  §5.4 already records that Agentless's ~93.6% file-level top-5 collapses to ~38%
  end-to-end. Multi-file localisation is harder than this document solves.

---

## 6. Data structures

| Structure | Cost | Use here? |
|---|---|---|
| **In-memory** inverted index `Map<token, Uint32Array>`, content + path | one pass; 0.3–1.5 s at ~6 M tokens | **Yes — this is the structure** (§6.3) |
| **Persistent** index on disk | 3× corpus (Zoekt), 20% (Cox) | Not until the source passes ~200 MB (§6.1) |
| Skip pointers on postings | +<20% size; Moffat's L=100 best for short queries | Only for posting lists above ~1000 entries; a linear merge over a `Uint32Array` wins below that |
| Roaring bitmaps for **filter sets** (branch mask, path prefix, language) | 2 B/elem sparse, 8 KiB dense | Yes **here** — dense and intersected often. Not for term postings, which are sparse |
| Trigram index (Zoekt; Russ Cox) | Zoekt: 3× corpus on disk, 1.2× in RAM. Cox: ~20% of corpus | **No** — the query is a handful of words, not a regex (§6.1) |
| FST term dictionary (Lucene) | compact, immutable | No — vocabulary is small and the index is per-repo |
| Suffix array / automaton (livegrep) | 3–5× indexed text; builder is not incremental | No — the author's own disqualifier: suffix arrays are "appreciably less amenable to incremental update" than trigrams |
| MinHash / LSH | k×4 B/doc signature; 400 hashes → error ≤0.05 | Yes, for near-duplicate **dedup** — not as a retrieval structure |
| HNSW / IVF-PQ | 732 MB per 1 M × 128-dim vectors | **No** — breaks the determinism contract (§6.2) |
| CSRs (`offsets[]` + `targets[]`) for the reference graph | two int arrays | A `Map<path, Set<path>>` is fine at repo scale |
| Content-addressed cache keyed by a Merkle root over `(path, SHA-256(bytes))` | one hash per file | Yes; content hash is the only correct invalidation key (§6.3) |

### 6.1 Do not build an index

ripgrep scans at roughly **0.6 GB/s per core** (GitHub's own cited benchmark: 13 GB
in 2.769 s on 8 cores). A 50 MB repository is ~0.1 s of single-core brute force —
less than the `git log` subprocess already on the critical path. Weighed against
that, the production structures cost 3× the corpus on disk (Zoekt), 3–5×
(livegrep), or 20% (Google Code Search) and buy latency this workload cannot use.

There is also a structural reason the trigram apparatus is unnecessary. It exists
to guarantee the prefilter excludes **nothing** that could match — which is why
Cox needs a five-tuple analysis per regex node and Zoekt requires at least one
positive atom per query. **A ranker returning top-k is allowed to miss files.**
That single relaxation deletes the hardest part of every design in that family.

The evidence that ngram indexing is wrong *specifically for this query
distribution* is Cox's own: a case-sensitive two-word query narrowed 36,972 files
to 25, a ~100× speedup; the case-insensitive version of the same query narrowed
them only to 599, ~20×. Task descriptions are natural language, so they are the
599 case, and GitHub abandoned fixed trigrams for the same reason — corpus-wide
grams like `for` are unselective.

**Sizing rule: the index becomes worth building somewhere past ~200 MB of
source**, or when one corpus is queried many times and the index can be cached
between runs. Key it by git tree hash so staleness is structurally impossible.
Aider's cache is mtime-keyed with the version in the directory name
(`.aider.tags.cache.v3/`), so a format change orphans the old directory instead of
requiring compatibility code — copy that.

### 6.2 Do not add an embedding tier

The blocker is determinism, not quality. ONNX Runtime float CPU inference is not
bit-exact across machines or even across CPU microarchitectures
(microsoft/onnxruntime #5667, #32600), so a ranker that promises byte-identical
output for identical input (R6) cannot contain one.

The quality case is weaker than it looks for this workload. Retrievers that go
text→text (a natural-language question) favour dense; retrievers that query by
identifier — which is what a task title mostly is — favour sparse, ahead by ~10
points EM in the published comparison. BM25 is at ceiling on function-naming
benchmarks, and dense-only retrieval *loses* to BM25 on SWE-bench-Lite.

If semantic retrieval is ever wanted, the honest shape is a pluggable reranker that
is off by default and never on the deterministic path — not a core dependency.

### 6.3 The shape to build

One pass produces two `Map<token, Uint32Array>` — content tokens and path tokens —
with doc IDs as indices into a file array. Intersect rarest-first by linear merge
over the sorted arrays; merge the path index with a multiplier at query time; score
with the §5.13 formula. That is the whole structure.

What is deliberately absent, and why:

- **No compression (delta + varint, SIMD-BP128).** Those are I/O optimisations: they
  shrink bytes on disk and cut decode bandwidth. Rebuilding in-process reads from
  the OS page cache, so the decode cost is paid and nothing is bought back. A
  compressed inverted file measures ~5.1% of source (Moffat & Zobel: 164 MB for a
  3 GB TREC collection), which is a disk number, not a latency one.
- **No FST.** ~7 bytes/term against 9.8 M terms is a real win; a few thousand files
  yield tens of thousands of tokens, where a `Map` wins on both size and build time.
- **No skip pointers, no impact ordering, no block-max WAND.** All three pay off
  above roughly 10⁵ postings per term. Below that the pruning machinery costs more
  than it saves.

**Determinism checklist** for the build: fixed tokenizer; explicit tie-break of
`(score desc, path asc)`; never iterate a `Set` or `Object` where order matters
(`Map` preserves insertion order, `Object` keys do not reliably); no `Math.random`;
integer-only hashing; fixed accumulation order for float sums.

**Cache the result, not the process.** Serialize the index and key it by a Merkle
root over `(relative path, SHA-256 of file bytes)` — directory hash = SHA-256 over
sorted `(name, child_hash)` pairs, computed bottom-up, which is exactly git's object
model. Compare the stored tree against the current one top-down and reindex only
changed subtrees, reading no unchanged file: a 10,000-file tree with one change then
costs ~15 file reads instead of 10,000. Content hashing rather than mtime/size is
the point — it survives `git checkout`, `npm install`, IDE save-on-focus and
`lint --fix`, where a size-only gate misses same-size edits. Do not skip a subtree
on unchanged parent *metadata* alone; recompute bottom-up or a deep content change
is missed silently.

### 6.4 If graph ranking arrives, do not recompute it exactly

§5.1 inherits Aider's PageRank, so this becomes live at that point. Exact
incremental recomputation is the wrong default: published speedups of 11× for an
unchanged graph fall to 1.75–1.87× once ~60% of the graph changes, and an
independent study found the exact variant rebuilding over half the classes when only
~1% had changed. The **approximated** variants with a tolerance threshold are the
ones worth having. The Monte Carlo incremental bound (`O(n ln m / ε²)` work with
random edge arrival) is attractive but holds only under random edge arrival;
adversarial orders blow it up.

---

## 7. Failure → recovery

| Failure | Detection | Behaviour | Recovery |
|---|---|---|---|
| Unreadable directory | `EACCES` per directory | Skip, note, continue | Agent's own tools still work |
| No discriminating signal | `NQC ≈ 0`, or top `normScore` below floor | `WEAK`: results returned, labelled, relax count stated | Agent can re-query with the label in hand |
| No term matched (`coverage = 0`) | coverage check, then one relaxation | `NO_RESULTS`: heuristic floor | Agent has the tree and can search |
| Uninformative query | `Σ idf` below `QUERY_IDF_FLOOR` | static default set, labelled low confidence | Agent reads the label and searches |
| Over budget | after the ladder | content → sections → clamp | never over-budget, never empty |
| Window too small | `needTokens > 0.85 × window` | shrink, then reroute to a wider-window candidate | currently throws |
| Ranker throws | call site | `FAILED`: tree-only, run proceeds | error on the run row |
| Gate conflict | `PLAN_BASE_DIRTY` | refuse | already correct — commit or `--force` |
| Ranking regression | recall@15 below recorded baseline | log, warn | offline gate before merge |

---

## 8. Phasing

1. **Defects.** EACCES hardening, budget clamp, `localeCompare` → codepoint compare,
   the acronym half of the `tokenize()` fix, and a file-type gate (§2.5, R13). These
   are independent of any design change and each is provable on its own.

   **Landed, with one scope change.** The floor moved to phase 5. §5.3 step 2 says
   lowering it is step 3's precondition, and that turns out to be a hard ordering, not
   a preference: at `< 3` the split recovers `ui`, `db`, `io`, `js` and `id`, and at
   the same time admits `to`, `of`, `in`, `is`, `do` and `an`, which then earn the full
   +10 basename weight. Whatever the floor buys, it pays for in short English function
   words that the `1/(1+df)` weight is the thing that damps. Shipping the floor without
   the weight is the strictly worse half of the pair, so both ship in phase 5 together.
   The acronym rule has no such pairing and shipped alone: `HTTPServer` now yields
   `http` and `server` instead of the unsplittable `httpserver`.
2. **Instrument and measure.** Gold set mined from `events`; recall@15 / MRR /
   nDCG@15 reporting. This is what makes everything after it provable.

   **Landed — `src/ranker-eval.mjs`, `ai-code eval`.** The baseline is in §2.6:
   14 usable runs, 33% of answers never offered, and a macro/micro recall gap of
   ten points that makes quoting either alone misleading. What building it
   surfaced — the read/search distinction, run-not-task scoping, the three path
   shapes, and the `k/|gold|` cap — is recorded in §5.12, because each one changes
   the number.

   The **debug record** of §5.10 is not in this phase. It exists to calibrate
   thresholds that do not exist yet, and nothing in phases 3 or 4 reads it; the
   metrics above are what those phases have to move. It moves to phase 5, beside
   the weights it feeds.
3. **Graph expansion** — §5.2's ×50 edge rule, named explicitly, plus the one-hop
   import scan that feeds it. Measured at **3 of 7** misses in §2.4, for near-zero
   cost: it is a regex over files the ranker already reads.

   **Landed — `importGraph()` and `frontier()` in `src/context.mjs`.** The scan
   reads 648 KB of source in one regex pass and resolves five spellings of a local
   import (ESM, dynamic, `require`, side-effect, and Python's dots-as-path form)
   plus its own reverse direction. Two departures from the section above, both
   forced by measurement rather than preference: **the ×50 ships as ×3**, because
   at 50 the graph is worse than not having one, and **the seed's fan-out divides
   its pull**, because undivided every weight is worse than not having a graph.
   Both are in §5.2 with the sweep; §2.4 has the before/after.

   The result is +5.3 macro recall / −2 unoffered on today's tree, and +21.5 /
   −11 on the tree of `066446e`. That second column is the more interesting one:
   it says the graph is what makes the score stop depending on which files happen
   to be in the working tree, which §2.6 shows costs 16 points on its own.

   Reversible by construction: `edge: 0` is the pre-phase-3 ranking exactly, and
   a test asserts it still is.
4. **Symbol-level retrieval with definition fan-out** (§5.1). **1 of 7** misses,
   but the one the graph cannot reach from a cold start — an import edge needs a
   seed, and this is what supplies it.

   **Landed — `declarations()` and `declaredBy()` in `src/context.mjs`.** The
   declaration scan is six regexes and one character class, and the character class
   is the design: requiring a match to start the line is what separates a
   declaration from a function-local binding, without which `input` resolves to two
   files rather than the one the whole phase rests on. Three departures, all in
   §5.1: the scope filter is the column, the **whole-identifier half of the section
   was built, measured at exactly 0.000000, and removed**, and the Rust patterns are
   not carried because no file here is Rust.

   The result is +11.1 macro recall / −5 unoffered against phase 3, and the
   ablation in §2.4 is the part worth keeping: graph +5.3, symbol +8.2, together
   +16.4 — superadditive, 22% more than the sum, which is §5.1's "an import edge
   needs a seed" turned into arithmetic. The cost is the four regressing runs, all
   one task whose gold is most of the repository.

   **The divisor is the one place this phase did not ship its best number.** The
   undivided pull beats the shipped `1/sqrt(n)` on every aggregate and zeroes three
   runs doing it, so the phase ships the variant with the lower mean and the higher
   floor. §2.4 and §5.2 both carry the table; §9 carries the argument for and
   against, unresolved. A later phase that measures what a consumer does with a
   wrong window — §6.3's index, or the reranking tier — should revisit it.

   Reversible by construction: `define: 0` is the phase-3 ranking exactly, to six
   decimals on all four metrics, and a test asserts it still is.
5. **Self-normalising weights and the floor** (§5.3). The tokenizer floor ships here,
   as a pair with step 3's `1/(1+df)` weight — see the note in phase 1. Also the
   **debug record** (§5.10), moved here from phase 2: `normScore` and `ceil(q)`
   are the inputs these weights are calibrated against, so record and calibration
   belong in one change.
6. **Window-derived budget, total shrink ladder, named degradation states** (§5.6, §5.9).
7. **Hierarchical render and content tier** (§5.4–5.5, §5.13), then the content
   index of §6.3 — and a *persistent* index only past the §6.1 threshold.

Phase 2 precedes 3 and 4 deliberately: without the baseline number, you cannot
tell whether graph expansion or definition fan-out earned the improvement. Phases 3
and 4 come before the content tier because together they reach 4 of the 7 misses at
a fraction of §5.13's complexity — the content tier is a complement, not the fix.

---

## 9. Unverified

- Section 1.1's reading of the gate direction is from the source; the claim that
  false blocks are "not hypothetical" rests on the comment at `src/service.mjs:734`
  rather than on an observed `PLAN_BASE_DIRTY` in the event log.
- `git log -n 200` returned 67 entries on 2026-09-23; the count is repository-state
  dependent and will drift.
- The per-run recall figures (38–46%) treat directories reported by `Grep`/`Glob`
  as non-files. Counting them differently moves the number by a few points.
- **§2.6's original baseline (`0.772` macro, 18 unoffered) does not reproduce** at
  the commit that carries it or at the tree in use now, and no explanation was
  found for the difference — not a stray file in the working tree, and not the
  recency signal. It is treated as unreliable rather than reconciled, and §2.6
  now reports two tree states measured directly instead.
- Every `ai-code eval` figure is a property of (ranker, tree). §2.6 measures the
  tree effect at 16 points of macro recall, so any comparison spanning a commit
  is confounded. Same-process, same-tree only.
- §5.2's measured weights come from 14 gold-bearing runs over 6 tasks, with 5 runs
  capped and two tasks carrying 8 of the 14. The *direction* of the two findings
  is well supported — the sweeps are monotone across a wide range and the
  leave-one-out is positive in every fold — but the values 3 and `1 + n` are not
  fitted, and §5.3's calibration phase can move them.
- The import scan resolves a specifier only within the repository. An alias
  (`@/lib/x`) or a path built at runtime draws no edge, so a repository that uses
  either gets less frontier than the design assumes — untested, and this
  repository has neither.
- Prior-art figures are from the cited sources, not reproduced here. Anything in
  §5 not attributed to a measurement or a source is inference.
- The prior-art numbers were gathered by research agents from fetched sources; the
  fetches were not re-checked. Specifically unchecked here: the ~20% BM25F
  improvement and the zoekt #912 IDF removal, the Aider edge-weight constants, the
  ~10-point sparse-over-dense EM gap, the BugLocator 62.6% figure, and the
  microsoft/onnxruntime issue numbers #5667 and #32600. The §2 and §4 findings,
  including every `tokenize()` output in §2.5, were produced by running the code
  in this repository.
- §5.3 step 3 assumes `df` is computable over the path list alone. If it is
  computed over file *contents* instead, the optimum shifts and the ~30-word
  stoplist in step 4 may become unnecessary — untested.
- The §6.1 `~200 MB` threshold is extrapolated from ripgrep's measured throughput,
  not measured against a repository that size.
- The §6.3 build-time estimate (0.3–1.5 s for ~6 M tokens in Node) is arithmetic,
  not a benchmark. Measure it on this repository before relying on it.
- The §6.3 Merkle read-savings figures (10,000 files / 1 change → ~15 reads) come
  from secondary write-ups of other indexers, not from a run here.
- The §6.4 incremental-PageRank speedups are from Desikan et al. (WWW '05) and the
  TUM thesis that qualifies them; neither graph resembles this one.
- §5.1's identifier-sub-token evidence is arXiv:2605.18561, which is a **preprint
  and not peer-reviewed**, with only the paper's own reported numbers. It is cited
  as the reason to try the intervention, not as proof it works here.
- §5.7's `NQC` uses `k = 100` from the source paper; the right `k` for a
  few-thousand-file repository is a guess. `QUERY_IDF_FLOOR` and
  `NO_MATCH_FLOOR` are both uncalibrated starting values.
- §5.13's field weight (`w = 5` on every non-content field) is borrowed from
  Sourcegraph's constant, not measured on this corpus. The `b = 0` on the path
  fields follows from the model's structure rather than from a measurement.
- §2.4's fan-out table probes 5 tokens out of ~15, so its "1 of 7" is a floor, not
  a count. The floor was the right number to carry into phase 4 anyway: the token
  it named is the one the phase recovers, and it is recovered for the reason the
  table gave.
- **Phase 4 ships the second-best divisor, and the argument for it is a
  judgment call.** Undivided beats `1/sqrt(n)` on macro (0.873 against 0.855),
  micro, nDCG (0.605 against 0.585), unoffered (13 against 15) and the
  leave-one-out floor (+8.3 against +6.2). It is rejected solely because it zeroes
  three of fourteen runs where the shipped variant leaves them at ~0.05. That is
  the right call if an empty-relevant window is categorically worse than a weak
  one, which is the position taken here and is not measured — nothing in this
  corpus says how a consumer behaves when it is handed fifteen wrong files instead
  of one right one. A preference for the mean, or a downstream stage that reranks
  hard enough to survive a drowned window, would flip the choice.
- **IDF is the principled divisor and loses on one metric.** It wins nDCG (0.591)
  and loses macro recall (0.848) at every weight tried. Recall is the headline here
  because §2.1 asks how much of what the planner needed was offered at all, but a
  consumer that cares which correct file comes *first* rather than how many arrive
  would pick IDF. Nothing measured settles which is right.
- **The column-0 scope filter is a proxy, not an analysis.** It counts a
  declaration form at the start of a line inside a comment or a template literal,
  and misses a genuine declaration that is indented for any reason — inside a class
  body, a namespace, an IIFE, or a `describe` block. Both error directions are
  unmeasured beyond the five tokens in §2.4's table. It is a scope filter that
  works on this corpus, not a scope analysis, and a repository that wraps its
  declarations would need the real thing.
- **Phase 4's four regressing runs are one task, and the pass has no way to tell
  that task from the others.** The Mission Control task's gold set is 16–27 files
  of 53; the fan-out reorders a window that was already overflowing and loses
  ground. There is no per-task guard — the pass cannot distinguish "the answer is
  most of the repository" from "the answer is three files". Whether the trade is
  worth taking depends on the task mix, and 14 runs of one repository is not that
  mix.
- **The Python and Ruby declaration patterns are untested.** They are reachable
  (`.py` and `.rb` are in `SOURCE_FILE`) and this tree contains no file of either
  language, so `def` and `class` have never matched anything here. They are carried
  on the argument that another repository will exercise them, which is the argument
  the Rust patterns were cut for not having.
