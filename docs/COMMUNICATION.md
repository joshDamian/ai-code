# Communication: the standard for every string a model writes

AI Code asks a model for eleven kinds of text, and all eleven end up in front of
a person: a plan, a review verdict, a chat answer, a session reply, a spec, a
batch of proposed tasks, a decision log, and the narration an implementer or a
repair leaves in the activity feed. This document is the house standard for
those strings.

It is derived from ASD-STE100 and it is not STE-compliant. §5 says why.

Two scope calls, both deliberate and both easy to reverse. This governs model
output, not the strings AI Code emits itself — CLI output, server error
messages, web toasts are not covered. And it is a *style* standard: it says how
a sentence is built, never what a run is allowed to say. The harness's
promises to a model (the read-only rule, the approval gate, the budget) stay in
the prompts that own them.

## 1. The distinction everything turns on

Text a person reads takes the rules. Machine syntax does not.

The exemption is per string, not per prompt. A review verdict is a JSON object
whose `verdict` field is one word of machine syntax and whose `review` field is
prose a person reads. The object obeys its schema; the prose obeys this
document.

Exempt, always: code, identifiers, flags, commands, file paths, URLs, error
messages, quoted text, and the keys and punctuation of a structured payload.
Never reword one of these to satisfy a rule.

## 2. Sentences

- A descriptive sentence carries at most 25 words. An instruction carries at
  most 20.
- Active voice. The imperative mood for instructions. One instruction per
  sentence.
- Simple tenses only. No `-ing` main verb. No contractions.
- Keep articles and verbs. Never drop grammar to go shorter.
- Never delete a fact to fit a limit. Split the sentence, or start a paragraph.

The last two are the ones a model breaks first. A word cap with no
fact-preservation clause is an instruction to cut content, and the model obeys
it.

## 3. Paragraphs and lists

- At most six sentences. One topic each.
- No floor. One sentence is a paragraph, and a bare answer is a fine one.
- Bullets for parallel items. Numbers for ordered steps, and nothing else.

The ceiling is STE rule 6.6. The floor is a composition-guide folk rule the
standard does not carry, and it outlaws "No." — which is the opening §6 asks
for.

## 4. Words

- One term per thing, every time. No synonym for variety.
- At most three words in a noun cluster (STE rule 2.1). Break a longer one with
  prepositions: "the indicator unit for the fault current of an overhead line",
  not "overhead line fault current indicator unit".
- No filler, no preamble, no metaphor.

| Use | Instead of |
|---|---|
| make sure | ensure |
| use | utilize, leverage |
| before | prior to |
| to | in order to |
| start | commence |
| stop | terminate |
| more | additional |
| enough | sufficient |
| can | is able to |

Never: seamless, robust, powerful, cutting-edge, comprehensive, effortless,
blazing, simply, just, obviously, of course.

Noun clusters are the highest-value rule here. Noun-stacking is how a sentence
gets dense and vague at the same time, and it is the failure a terse register
drifts into.

## 5. What this cannot claim

STE100 is two things: 53 writing rules, and a controlled dictionary of about
900 approved words. The rules transfer. The dictionary does not — it exists in
a PDF, no model carries it, and STE admits a domain term only through a project
glossary.

So this is *STE-derived*. No surface in AI Code says "STE compliant"; ASD says
no tool certifies that anyway. The dictionary's job is done by §4's swap list
plus the glossary in §7.

The register is also flatter than STE's. STE is written for readers who may die
if they misread something, so it repeats nouns instead of using pronouns and
forbids idiom outright. AI Code's readers are not in that position, and a
review verdict that repeats "the implementation" five times reads worse than
one that says "it".

## 6. Format

- The first sentence is the answer or the action.
- Bold only the term a reader scans for. Bold everywhere is bold nowhere.
- A list only when the items are a list.

## 7. The glossary

Per project, human-owned, one fixed meaning per term.

It lives in the project's `conventions.md`, and the machinery already exists:
`src/context.mjs` reads that file into every role's prompt
(`readDoc(project.path, 'conventions.md')`, context.mjs:1566), so a term
defined there reaches all eleven prompts without a new code path.

One caveat worth knowing before relying on it. `conventions.md` is the second
thing trimmed under budget pressure (context.mjs:1620) — after the
lowest-ranked files, before `architecture.md` and the spec. A run that meets
its budget carries the glossary. A run that does not loses it, and the model
falls back to its own reading of the term.

## 8. Where this binds

The whole set reaches every prompt at one point. `runRole` assembles the
request at one place, and all eleven prompts pass through it: the const
`STYLE_RULES` (src/service.mjs) is appended after `INSTRUCTIONS:` in the
template, inside both the assembled request and the `fixed` estimate the
context budget and the 85% check measure. No prompt needed an edit, and no
test that pins one changed.

The precedent is `payloadInstruction` (src/service.mjs:565): the fenced-JSON
contract for the four drafting prompts is stated once because "a contract
stated three times is a contract that drifts".

### The eleven

| Prompt | Line | Writes |
|---|---|---|
| `PLANNER_PROMPT` | 448 | the plan |
| `reviewerPrompt(diff)` | 424 | `{verdict, review}` |
| `verificationPrompt({…})` | 445 | `{verdict, review}` |
| `CHAT_PROMPT` | 465 | the answer |
| `SESSION_PROMPT` | 494 | the reply |
| `INTAKE_PROMPT` | 571 | spec + fenced JSON |
| `PROPOSALS_PROMPT` | 589 | proposals + fenced JSON |
| `INFER_SPEC_PROMPT` | 606 | spec + fenced JSON |
| `DECISIONS_PROMPT` | 619 | fenced JSON |
| implementer, inline and unnamed | 2543 | code + narration |
| repair, inline and unnamed | 2898 | code + narration |

## 9. How it applies

Prompt-only. The block is injected into every prompt at the one assembly
point in `runRole`, so the rules bind the way the prompt binds: a rule set
the model is asked to follow while it writes.

A rewrite pass over the finished draft is rejected: it doubles every run's
model calls, and the second pass is where the first pass's cost lands for a
gain that is mostly formatting. A checker that blocks a run is rejected: it
fails work on style.

Two of the rules are countable — sentence length and noun-cluster length —
and a checker that records violations rather than blocking is a possible
follow-up. It is not built here.
