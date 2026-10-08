// SUBJECT: the instructions (prompt) for the Jarvis Night Watch report writer.
//
// THIS FILE IS THE FROZEN EXAM. The improving "agent" never sees its code and cannot change it:
// it only ever outputs plain text (a proposed prompt). Change the rules below only by hand.
//
// The right answers come from `oracle()`, a fixed rule set (edit it if you disagree with a rule):
//   FAIL  Jarvis is not loaded, or the cockpit does not answer http 200
//   WARN  Jarvis exited non-zero, OR a syntax error exists, OR more than 10 error-like log lines, OR disk is over 90% full
//   OK    everything else. A "SKIPPED" check is neutral: judge only the checks that ran.
import os from 'node:os';
import path from 'node:path';

export const ID = 'jarvis-health';
const BASE = { loaded: true, exitStatus: 0, http: 200, errLines: 3, syntaxBad: 0, diskPct: 4, skipped: false };

/** Fixed facts text in the same shape the real collect.sh produces. */
export function renderFacts(p) {
  const L = [];
  L.push('date: Tue Oct  6 21:00:05 EDT 2026', '== LaunchAgent ==');
  if (p.loaded) L.push(`44945\t${p.exitStatus}\tlocal.jarvis.assistant`, '77506\t0\tlocal.automations.jarvis-health');
  else L.push('77506\t0\tlocal.automations.jarvis-health', 'NOT LOADED');
  L.push('== Cockpit HTTP (port 53284) ==', p.http === 'none' ? 'no response' : `http ${p.http}`);
  L.push('== Recent log errors (last 200 lines) ==');
  if (p.skipped) L.push('SKIPPED: macOS privacy blocks background jobs from reading the Documents folder (not a Jarvis problem). Log check not run.');
  else L.push(`error-like lines: ${p.errLines}`);
  L.push('== Python syntax check (no files written) ==');
  if (p.skipped) L.push('SKIPPED: macOS privacy blocks background jobs from reading the Documents folder (not a Jarvis problem). Syntax check not run.');
  else L.push(...Array.from({ length: p.syntaxBad }, (_, i) => `SYNTAX ERROR: /x/jarvis-local/file${i + 1}.py`), `files with syntax errors: ${p.syntaxBad}`);
  const used = Math.round((p.diskPct / 100) * 926);
  L.push('== Disk ==', `/dev/disk3s1s1   926Gi    ${used}Gi   ${926 - used}Gi    ${p.diskPct}%    486k  4.3G    0%   /`, '== Newest Jarvis reports ==', 'daily-brief-76dac79d.md', 'ai-news-af11b097.md');
  return L.join('\n');
}

const CAUSE_RE = {
  notLoaded: /not loaded|isn.?t loaded|launch ?agent/i,
  http: /http|cockpit|respond|port|answer/i,
  exit: /exit/i,
  syntax: /syntax/i,
  errors: /error/i,
  disk: /disk/i,
};

/** The fixed rules. Returns the correct status and which causes a good report must mention. */
export function oracle(p) {
  const causes = [];
  let status = 'OK';
  if (!p.loaded) { status = 'FAIL'; causes.push('notLoaded'); }
  if (p.http !== 200) { status = 'FAIL'; causes.push('http'); }
  if (status !== 'FAIL') {
    if (p.loaded && p.exitStatus !== 0) { status = 'WARN'; causes.push('exit'); }
    if (!p.skipped && p.syntaxBad > 0) { status = 'WARN'; causes.push('syntax'); }
    if (!p.skipped && p.errLines > 10) { status = 'WARN'; causes.push('errors'); }
    if (p.diskPct > 90) { status = 'WARN'; causes.push('disk'); }
  } else {
    if (p.loaded && p.exitStatus !== 0) causes.push('exit');
  }
  return { status, causes };
}

const C = (id, over) => ({ id, params: { ...BASE, ...over } });

/** DEV: the improving agent is shown failures from these. */
export const DEV = [
  C('dev-healthy', {}),
  C('dev-healthy-skipped', { skipped: true }),
  C('dev-not-loaded', { loaded: false }),
  C('dev-no-http', { http: 'none' }),
  C('dev-http-500', { http: 500 }),
  C('dev-exit-1', { exitStatus: 1 }),
  C('dev-syntax-1', { syntaxBad: 1 }),
  C('dev-errors-25', { errLines: 25 }),
  C('dev-disk-94', { diskPct: 94 }),
  C('dev-errors-8-normal', { errLines: 8 }),
  C('dev-skipped-no-http', { skipped: true, http: 'none' }),
  C('dev-skipped-exit-78', { skipped: true, exitStatus: 78 }),
];

/** HELD-OUT: never shown to the improving agent. Used only to check an improvement is real, not memorised. */
export const HELDOUT = [
  C('held-healthy-disk-60', { diskPct: 60 }),
  C('held-skipped-disk-12', { skipped: true, diskPct: 12 }),
  C('held-errors-11-boundary', { errLines: 11 }),
  C('held-errors-10-ok', { errLines: 10 }),
  C('held-disk-91', { diskPct: 91 }),
  C('held-disk-90-ok', { diskPct: 90 }),
  C('held-not-loaded-no-http', { loaded: false, http: 'none' }),
  C('held-multi-warn', { exitStatus: 1, syntaxBad: 2, diskPct: 95 }),
];

const words = (s) => (String(s).trim().match(/\S+/g) || []).length;

/** Deterministic score in [0,1] for one output. No model involved. */
export function score(c, output) {
  const out = String(output || '');
  const want = oracle(c.params);
  const m = /^\s*STATUS:\s*(OK|WARN|FAIL)\b/im.exec(out);
  const got = m ? m[1].toUpperCase() : null;
  const format = /^\s*STATUS:/im.test(out) && /^\s*PROBLEMS:/im.test(out) && /^\s*NEXT STEP:/im.test(out);
  const short = words(out) <= 160;
  const needed = want.causes.map((k) => CAUSE_RE[k]);
  if (want.status === 'OK' && c.params.skipped) needed.push(/skipp/i);
  const mentioned = needed.length ? needed.filter((re) => re.test(out)).length / needed.length : 1;
  let clean = !/privacy settings/i.test(out);
  if (want.status === 'OK') clean = clean && !/\bsyntax error\b|\bnot loaded\b|no response/i.test(out.replace(/skipp\w*[^\n]*/gi, ''));
  const total = (got === want.status ? 0.5 : 0) + (format ? 0.15 : 0) + (short ? 0.1 : 0) + 0.2 * mentioned + (clean ? 0.05 : 0);
  return { total: Math.round(total * 1000) / 1000, got, want: want.status, format, short, mentioned, clean };
}

export default {
  id: ID,
  name: 'Jarvis Night Watch report writer',
  agent: 'job-jarvis-health',
  describe: 'The instructions that turn raw health facts into the nightly Jarvis report (OK / WARN / FAIL). Scored on the right status, the format, brevity and mentioning the real cause.',
  promptPath: path.join(os.homedir(), 'Automations', 'jarvis-health', 'prompt.md'),
  compose: (prompt, facts) => `${prompt.trimEnd()}\n\n--- FACTS ---\n${facts}`,
  factsOf: (c) => renderFacts(c.params),
  // The owner's rules in plain words. The improver is TOLD these (they are the specification), but never sees the exam cases.
  spec: [
    'STATUS is FAIL if the Jarvis launch agent is not loaded, or the cockpit does not answer with http 200.',
    'Otherwise STATUS is WARN if ANY of these is true: Jarvis last exit status is not 0; there is at least one Python syntax error; there are MORE THAN 10 error-like log lines (10 or fewer is normal and fine); the disk is MORE THAN 90 percent full (90 or less is fine).',
    'Otherwise STATUS is OK.',
    'A line starting with SKIPPED means a check could not run because of macOS privacy. That is neutral: judge only the checks that ran, never treat it as a problem, and when STATUS is OK mention in one short note that some checks were skipped.',
    'Never suggest changing macOS privacy settings. Never invent problems. Name the real cause for every WARN or FAIL.',
    'Keep the report under 150 words with the three lines STATUS:, PROBLEMS: and NEXT STEP:.',
  ].join('\n'),
  dev: DEV,
  heldout: HELDOUT,
  score,
};
