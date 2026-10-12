// @ts-check
// Configuration from the environment. Every variable is BENCH_<NAME>; the AI_CODE_<NAME>
// spelling from before the rename is still read, so an existing setup keeps working.

/** @param {string} name without the prefix, e.g. 'ROOT' @returns {string|undefined} */
export function env(name) {
  return process.env[`BENCH_${name}`] ?? process.env[`AI_CODE_${name}`];
}
