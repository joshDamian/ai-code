#!/usr/bin/env node
// Refuses the command that clears a port by killing whoever is holding it.
//
// On 2026-09-23 an implementer needed a port for a smoke test, found the live
// dashboard holding the default one, and freed it with
//   lsof -i :4317 | grep -v COMMAND | awk '{print $2}' | xargs kill -9
// The dashboard was that agent's own parent, so the kill ended the run too, and two
// runs were left `running` with nothing alive to write an ending.
//
// Agent runs pass --dangerously-skip-permissions, which skips the permission prompt
// but not PreToolUse hooks, so this is the one layer that can still refuse.
//
// The rule is narrow on purpose. A kill is denied when its target set is computed
// rather than named - a port lookup piped into kill, a command substitution, a bare
// interpreter name - because no reader can tell from the command what it will kill.
// A kill that names its target stays allowed: `pkill -f "node src/server.mjs"` names
// a path and `kill 4321` names a pid, which is how an agent legitimately stops its
// own smoke-test server.
//
// The cost is deliberate and worth stating: `lsof -ti:4399 | xargs kill`, a sweep
// scoped to a port the agent chose itself, is refused along with the dangerous ones,
// because a rule that has to guess which port is safe is the rule that failed here.
// The remedy is one process further down: kill the pid you started.
//
// Only runs with no human to prompt are guarded. Killing the dashboard from the
// user's own shell is a legitimate thing for the user to do, and bypassPermissions
// is exactly what separates an agent run from the user's terminal.
//
// Denial is exit 2 with the reason on stderr: that is the mechanism the hook docs
// name for enforcing policy, and it does not depend on stdout parsing as JSON.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const KILL = /\b(kill|killall|pkill)\b/;
const LOOKUP = /\b(lsof|pgrep|pidof|ps)\b/;

const REMEDY =
  ' If a server you started cannot bind its port, start it with PORT=0 and read the port\n' +
  'it prints - your environment already defaults every server to that. To stop a server\n' +
  'you started yourself, kill the pid you started (`echo $!`), not every process with\n' +
  'its name, and never the process that holds the dashboard port: the dashboard is the\n' +
  'parent of this run, so killing it kills the work in flight.';

// Split on statement boundaries but not on `|`, so a pipeline stays one statement and
// an unrelated `ps` elsewhere in a multi-line script cannot condemn a kill by locality
// it does not have.
function statements(command) {
  return String(command || '').split(/\n|;|&&|\|\|/);
}

// Exported so a test can ask the question directly; the script's own entry point is
// the stdin/stdout wrapper below.
export function denial(command) {
  for (const s of statements(command)) {
    if (!KILL.test(s)) continue;
    if (LOOKUP.test(s)) {
      return 'this kill looks its targets up at runtime (lsof/pgrep/ps piped into kill), so it can reach any process on the machine';
    }
    if (/\bkill\w*\b[^|]*\$\(/.test(s) || /\bkill\w*\b[^|]*`/.test(s)) {
      return 'this kill takes its targets from a command substitution, so it can reach any process on the machine';
    }
    if (/\bkillall\b/.test(s)) {
      return 'killall takes every process with that name, not the one you started';
    }
    const usage = s.match(/\bpkill\b([^|]*)/);
    if (usage) {
      const words = usage[1].trim().split(/\s+/).filter((w) => w && !w.startsWith('-'));
      if (words.length && words.every((w) => !/[/:.]/.test(w))) {
        return `\`pkill ${words.join(' ')}\` matches every ${words[0]} on the machine, not the server you started`;
      }
    }
  }
  return null;
}

function main() {
  let payload = {};
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    // A payload this cannot read is not evidence of a dangerous command.
  }
  if (payload?.permission_mode !== 'bypassPermissions') return;
  const why = denial(payload?.tool_input?.command);
  if (!why) return;
  process.stderr.write(`Denied: ${why}.${REMEDY}\n`);
  process.exit(2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
