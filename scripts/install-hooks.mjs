#!/usr/bin/env node
// Adds (or removes) the Agency HQ hook in Claude Code's user settings. Idempotent, backs up first, touches nothing else.
//   node scripts/install-hooks.mjs            install
//   node scripts/install-hooks.mjs --remove   uninstall
//   --settings <file>                         use a different settings file (for testing)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// PostToolUse(+Failure) only for Bash: we only care whether a test run passed, and this keeps overhead low.
export const SPECS = [
  { event: 'UserPromptSubmit' }, { event: 'PreToolUse' }, { event: 'Notification' }, { event: 'Stop' },
  { event: 'SubagentStart' }, { event: 'SubagentStop' }, { event: 'SessionEnd' },
  { event: 'PostToolUse', matcher: 'Bash' }, { event: 'PostToolUseFailure', matcher: 'Bash' },
];
export const EVENTS = SPECS.map((x) => x.event);
export const MARKER = 'agency-hq/hook/agency-hook.mjs';

/** Pure: return a new settings object with our hook added (or removed). Never mutates the input. */
export function applyHooks(settings, command, { remove = false } = {}) {
  const next = JSON.parse(JSON.stringify(settings || {}));
  next.hooks = next.hooks || {};
  const ours = (h) => h && typeof h.command === 'string' && h.command.includes(MARKER);
  for (const { event: ev, matcher } of SPECS) {
    const groups = (next.hooks[ev] || [])
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !ours(h)) }))
      .filter((g) => g.hooks.length);
    if (!remove) groups.push({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command, async: true, timeout: 5 }] });
    if (groups.length) next.hooks[ev] = groups; else delete next.hooks[ev];
  }
  if (!Object.keys(next.hooks).length) delete next.hooks;
  return next;
}

function main() {
  const args = process.argv.slice(2);
  const remove = args.includes('--remove');
  const si = args.indexOf('--settings');
  const file = si >= 0 ? args[si + 1] : path.join(os.homedir(), '.claude', 'settings.json');
  const hook = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hook', 'agency-hook.mjs');
  const nodeBin = fs.existsSync('/opt/homebrew/bin/node') ? '/opt/homebrew/bin/node' : process.execPath;
  const command = `${nodeBin} ${path.resolve(hook)}`;
  const current = JSON.parse(fs.readFileSync(file, 'utf8'));
  const backup = `${file}.agency-hq.bak`;
  if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
  const next = applyHooks(current, command, { remove });
  JSON.parse(JSON.stringify(next)); // sanity: must serialise
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`${remove ? 'Removed' : 'Installed'} Agency HQ hooks in ${file} (backup: ${backup})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
