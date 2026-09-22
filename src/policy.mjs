import fs from 'node:fs';
import path from 'node:path';

// routing.json holds one object per role plus a top-level `health` block. Only
// the roles are per-role, so anything that walks the file must walk this list
// rather than Object.keys, or it will treat `health` as a fifth role.
const ROLES = ['planner', 'implementer', 'reviewer', 'repair'];

// Per-role routing policy. The four weights are only meaningful relative to each
// other: scoring multiplies each model's quality/speed/cost by the policy's own
// weight, so a role that cares about speed sets a high speed weight.
//
// timeout is in seconds. maxToolCalls and maxRunCost (USD) are budgets rather
// than schedules: a wall clock does not stop an agent that is busy the whole
// time, which is how a planning run once spent three and a half minutes and
// $2.21 rediscovering a codebase it had been given no files for. A planner and a
// reviewer explore and answer, so they get a tight budget; the two roles that
// actually edit and test get a wide one. Unset or non-positive means no limit.
const defaults = {
  planner: { strategy: 'quality', preferred: [], fallback: [], quality: 1, cost: 0.2, speed: 0.1, effort: 'high', timeout: 300, maxToolCalls: 40, maxRunCost: 1 },
  implementer: { strategy: 'balanced', preferred: [], fallback: [], quality: 0.5, cost: 0.2, speed: 1, effort: 'medium', timeout: 600, maxToolCalls: 200, maxRunCost: 5 },
  reviewer: { strategy: 'quality', preferred: [], fallback: [], quality: 1, cost: 0.1, speed: 0.3, effort: 'high', timeout: 300, maxToolCalls: 40, maxRunCost: 1 },
  repair: { strategy: 'speed', preferred: [], fallback: [], quality: 0.2, cost: 0.4, speed: 1, effort: 'medium', timeout: 600, maxToolCalls: 200, maxRunCost: 5 },
  // Circuit-breaker thresholds. Absent means the defaults in src/health.mjs apply.
  health: {},
  // Prompt budget for the context assembler. Absent means the defaults in
  // src/context.mjs apply.
  context: {},
};

// Model ids were renamed when the registry gained provider-qualified ids. A saved
// routing.json may still hold the old spelling, so rewrite it on read.
const RENAMED = {
  'anthropic-claude-code:claude-opus': 'anthropic:claude-opus-5',
  'anthropic-claude-code:claude-sonnet': 'anthropic:claude-sonnet-5',
  'deepseek-claude-code:deepseek-deepseek-flash[1m]': 'deepseek:deepseek-flash',
  'deepseek-claude-code:deepseek-deepseek-flash': 'deepseek:deepseek-flash',
};

function normalize(p) {
  const out = { ...p };
  for (const role of ROLES) {
    // A role absent from the saved file falls back to its default rather than
    // becoming undefined.
    out[role] = { ...defaults[role], ...out[role] };
    for (const key of ['preferred', 'fallback']) {
      out[role][key] = (out[role][key] || []).map((x) => RENAMED[x] || x);
    }
  }
  return out;
}

export function loadPolicies(root) {
  const f = path.join(root, '.ai-code', 'routing.json');
  if (!fs.existsSync(f)) {
    // First run: write the defaults out so the file is there to be edited.
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(defaults, null, 2));
    return structuredClone(defaults);
  }
  try {
    // Shallow merge: a saved role replaces the default role wholesale, so a
    // partially written role keeps only the keys it actually has.
    return normalize({ ...defaults, ...JSON.parse(fs.readFileSync(f, 'utf8')) });
  } catch {
    // A corrupt or unreadable file falls back to defaults rather than failing the
    // command that just wanted to route something.
    return structuredClone(defaults);
  }
}

export function savePolicies(root, p) {
  const merged = normalize({ ...defaults, ...p });
  const f = path.join(root, '.ai-code', 'routing.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(merged, null, 2));
  return merged;
}

export { defaults, ROLES };
