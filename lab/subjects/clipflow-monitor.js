// SUBJECT: the instructions (prompt) for the Clipflow Night Watch report writer.
//
// THIS FILE IS THE FROZEN EXAM (read-only on disk). The improving agent never sees its code and only ever outputs plain text.
// The right answers come from `oracle()`, a fixed rule set you can edit by hand if you disagree:
//   FAIL  the monitor job is not loaded, OR its log is missing, OR the log has not been written for MORE THAN 30 minutes
//   WARN  (otherwise) the log is 11 to 30 minutes old, OR 10+ of the last 50 runs attempted nothing, OR 10+ runs had everything rejected,
//         OR failed profiles are more than 25% of attempted, OR a run took more than 300 seconds, OR one error line repeats 20+ times
//   OK    everything else. A non-zero exit code (for example 2, "provider work deferred") is NEUTRAL while the log is fresh.
import os from 'node:os';
import path from 'node:path';

export const ID = 'clipflow-monitor';
const BASE = { loaded: true, logAge: 3, a0: 2, rejAll: 6, failedAvg: 1.1, attemptedAvg: 28.3, maxDur: 109, errRepeat: 3, exit: 2 };

/** Fixed facts text in the same shape the real collect.sh produces. */
export function renderFacts(p) {
  const L = ['date: Tue Oct  6 21:05:03 EDT 2026', '== launchd job com.clipflow.monitor =='];
  if (p.loaded) L.push('\tstate = not running', '\truns = 251', `\tlast exit code = ${p.exit}`, '\t\tstate = active', '\t\tstate = active');
  L.push('== monitor.log freshness ==');
  const missing = p.logAge === 'missing';
  L.push(missing ? 'monitor.log missing' : `last write: ${p.logAge} minutes ago (job should run every 5 minutes while the Mac is awake)`);
  L.push('== last 50 monitor runs (summary) ==');
  if (missing) L.push('no parseable run lines');
  else L.push('runs parsed: 50', `runs with attempted=0: ${p.a0}`, 'runs with any failed profile: 48', `avg failed per run: ${p.failedAvg.toFixed(2)} of avg attempted ${p.attemptedAvg.toFixed(1)}`, `runs where everything checked was rejected: ${p.rejAll}`, `duration seconds: avg 51, max ${p.maxDur}`);
  L.push('== error log (counts of distinct lines) ==');
  if (p.errRepeat > 0) L.push(`   ${p.errRepeat} Provider work deferred: URLError`, '   1 Provider work deferred: TimeoutError');
  else L.push('error log empty');
  return L.join('\n');
}

const CAUSE_RE = {
  notLoaded: /not loaded|launch ?agent|launchd|isn.?t loaded/i,
  stale: /log|stale|updated|minutes|missing|write/i,
  empty: /attempted|empty|zero|no profiles|nothing/i,
  rejected: /reject/i,
  failing: /fail/i,
  slow: /duration|slow|seconds|long|took/i,
  errors: /error|urlerror|timeout|repeat|network/i,
};

/** The fixed rules. Returns the correct status and which causes a good report must mention. */
export function oracle(p) {
  const causes = [];
  let status = 'OK';
  if (!p.loaded) { status = 'FAIL'; causes.push('notLoaded'); }
  const missing = p.logAge === 'missing';
  if (missing || p.logAge > 30) { status = 'FAIL'; causes.push('stale'); }
  if (status !== 'FAIL') {
    if (p.logAge > 10) { status = 'WARN'; causes.push('stale'); }
    if (p.a0 >= 10) { status = 'WARN'; causes.push('empty'); }
    if (p.rejAll >= 10) { status = 'WARN'; causes.push('rejected'); }
    if (p.failedAvg / p.attemptedAvg > 0.25) { status = 'WARN'; causes.push('failing'); }
    if (p.maxDur > 300) { status = 'WARN'; causes.push('slow'); }
    if (p.errRepeat >= 20) { status = 'WARN'; causes.push('errors'); }
  }
  return { status, causes };
}

const C = (id, over) => ({ id, params: { ...BASE, ...over } });

/** DEV: the improving agent is shown failures from these. */
export const DEV = [
  C('dev-healthy', {}),
  C('dev-exit-0', { exit: 0 }),
  C('dev-log-stale-45', { logAge: 45 }),
  C('dev-log-missing', { logAge: 'missing' }),
  C('dev-not-loaded', { loaded: false }),
  C('dev-log-age-20', { logAge: 20 }),
  C('dev-attempted0-12', { a0: 12 }),
  C('dev-rejected-15', { rejAll: 15 }),
  C('dev-failing-high', { failedAvg: 12, attemptedAvg: 28 }),
  C('dev-slow-400', { maxDur: 400 }),
  C('dev-errors-repeat-30', { errRepeat: 30 }),
  C('dev-exit-78-fresh', { exit: 78 }),
];

/** HELD-OUT: never shown to the improving agent. Used only to check an improvement is real, not memorised. */
export const HELDOUT = [
  C('held-log-age-10-ok', { logAge: 10 }),
  C('held-log-age-11', { logAge: 11 }),
  C('held-log-age-31', { logAge: 31 }),
  C('held-attempted0-9-ok', { a0: 9 }),
  C('held-attempted0-10', { a0: 10 }),
  C('held-slow-301', { maxDur: 301 }),
  C('held-failing-29pct', { failedAvg: 8.1, attemptedAvg: 28 }),
  C('held-multi-warn', { rejAll: 12, maxDur: 350, errRepeat: 25 }),
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
  const mentioned = needed.length ? needed.filter((re) => re.test(out)).length / needed.length : 1;
  let clean = !/\b(post(s|ing|ed)?|deploy\w*|publish\w*|release held)\b/i.test(out);
  if (want.status === 'OK') clean = clean && !/\bstale\b|\bnot loaded\b|log missing|log is missing/i.test(out);
  const total = (got === want.status ? 0.5 : 0) + (format ? 0.15 : 0) + (short ? 0.1 : 0) + 0.2 * mentioned + (clean ? 0.05 : 0);
  return { total: Math.round(total * 1000) / 1000, got, want: want.status, format, short, mentioned, clean };
}

export default {
  id: ID,
  name: 'Clipflow Night Watch report writer',
  agent: 'job-clipflow-monitor',
  describe: 'The instructions that turn the Clipflow monitor log facts into the nightly report (OK / WARN / FAIL). Scored on the right status, the format, brevity and naming the real cause. It must never suggest posting or deploying.',
  promptPath: path.join(os.homedir(), 'Automations', 'clipflow-monitor', 'prompt.md'),
  compose: (prompt, facts) => `${prompt.trimEnd()}\n\n--- FACTS ---\n${facts}`,
  factsOf: (c) => renderFacts(c.params),
  // The owner's rules in plain words. The improver is TOLD these (they are the specification), but never sees the exam cases.
  spec: [
    'HOW TO READ THE FACTS: under "== launchd job com.clipflow.monitor ==" a job that is loaded ALWAYS shows "state = not running" between its 5-minute runs. That is NORMAL and never a problem by itself. The job is NOT LOADED only when that section has no lines at all under it.',
    'STATUS is FAIL if the monitor job is not loaded, OR its log file is missing, OR the log was last written MORE THAN 30 minutes ago (the job should run every 5 minutes).',
    'Otherwise STATUS is WARN if ANY of these is true: the log was last written 11 to 30 minutes ago; 10 or more of the last 50 runs attempted nothing (attempted=0); 10 or more runs had everything checked rejected; failed profiles are MORE THAN 25 percent of attempted profiles (average failed per run divided by average attempted); the longest run took MORE THAN 300 seconds; one error line is repeated 20 or more times. (A log written 10 minutes ago or less, 9 or fewer empty runs, and failures of 25 percent or less are all normal.)',
    'Otherwise STATUS is OK.',
    'A non-zero launchd exit code (for example 2, meaning provider work was deferred after a network hiccup) is NEUTRAL: it is not a problem as long as the log is fresh.',
    'Never suggest posting, releasing held posts, deploying, or changing any account. Never invent problems. Name the real cause for every WARN or FAIL.',
    'Keep the report under 150 words with the three lines STATUS:, PROBLEMS: and NEXT STEP:.',
  ].join('\n'),
  dev: DEV,
  heldout: HELDOUT,
  score,
};
