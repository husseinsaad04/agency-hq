import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import clip, { oracle, score, renderFacts, DEV, HELDOUT } from '../lab/subjects/clipflow-monitor.js';
import jarvis from '../lab/subjects/jarvis-health.js';
import { proposerPrompt, runCycle } from '../lab/engine.js';
import { createLab } from '../server/lab.js';
import { openDb } from '../server/db.js';
import { createProgress } from '../server/progress.js';

const P = (o = {}) => ({ loaded: true, logAge: 3, a0: 2, rejAll: 6, failedAvg: 1.1, attemptedAvg: 28.3, maxDur: 109, errRepeat: 3, exit: 2, ...o });
const WORDS = { notLoaded: 'job not loaded in launchd', stale: 'log not updated for many minutes', empty: 'many runs attempted nothing', rejected: 'many runs rejected', failing: 'too many profiles fail', slow: 'a run took too many seconds', errors: 'same network error repeated' };
const perfect = (c) => { const w = oracle(c.params); return `STATUS: ${w.status}\nPROBLEMS: ${w.causes.map((k) => WORDS[k]).join(', ') || 'none'}\nNEXT STEP: nothing needed`; };

test('Clipflow rules: every boundary is exactly as written', () => {
  assert.equal(oracle(P()).status, 'OK');
  assert.equal(oracle(P({ exit: 78 })).status, 'OK', 'a non-zero exit is neutral while the log is fresh');
  assert.equal(oracle(P({ logAge: 10 })).status, 'OK');
  assert.equal(oracle(P({ logAge: 11 })).status, 'WARN');
  assert.equal(oracle(P({ logAge: 30 })).status, 'WARN');
  assert.equal(oracle(P({ logAge: 31 })).status, 'FAIL');
  assert.equal(oracle(P({ logAge: 'missing' })).status, 'FAIL');
  assert.equal(oracle(P({ loaded: false })).status, 'FAIL');
  assert.equal(oracle(P({ a0: 9 })).status, 'OK');
  assert.equal(oracle(P({ a0: 10 })).status, 'WARN');
  assert.equal(oracle(P({ rejAll: 9 })).status, 'OK');
  assert.equal(oracle(P({ rejAll: 10 })).status, 'WARN');
  assert.equal(oracle(P({ failedAvg: 7, attemptedAvg: 28 })).status, 'OK', '25 percent exactly is fine');
  assert.equal(oracle(P({ failedAvg: 8, attemptedAvg: 28 })).status, 'WARN');
  assert.equal(oracle(P({ maxDur: 300 })).status, 'OK');
  assert.equal(oracle(P({ maxDur: 301 })).status, 'WARN');
  assert.equal(oracle(P({ errRepeat: 19 })).status, 'OK');
  assert.equal(oracle(P({ errRepeat: 20 })).status, 'WARN');
  assert.equal(oracle(P({ logAge: 99, rejAll: 99 })).status, 'FAIL', 'FAIL beats WARN');
  assert.deepEqual(oracle(P({ rejAll: 12, maxDur: 350, errRepeat: 25 })).causes.sort(), ['errors', 'rejected', 'slow']);
});

test('Clipflow facts look like the real collect.sh output, and the normal case matches the real monitor', () => {
  const f = renderFacts(P());
  assert.match(f, /== launchd job com\.clipflow\.monitor ==\n\tstate = not running\n\truns = 251\n\tlast exit code = 2/);
  assert.match(f, /last write: 3 minutes ago \(job should run every 5 minutes/);
  assert.match(f, /avg failed per run: 1\.10 of avg attempted 28\.3/);
  assert.match(f, /duration seconds: avg 51, max 109/);
  assert.match(renderFacts(P({ logAge: 'missing' })), /monitor\.log missing[\s\S]*no parseable run lines/);
  assert.ok(!renderFacts(P({ loaded: false })).includes('last exit code'));
  assert.match(renderFacts(P({ errRepeat: 0 })), /error log empty/);
});

test('Clipflow exam shape: 12 + 8 cases, unique, hidden cases are not copies of practice ones, file is read-only', () => {
  assert.equal(DEV.length, 12);
  assert.equal(HELDOUT.length, 8);
  const ids = [...DEV, ...HELDOUT].map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  const facts = new Set(DEV.map((c) => renderFacts(c.params)));
  assert.ok(HELDOUT.every((c) => !facts.has(renderFacts(c.params))));
  assert.equal(fs.statSync(new URL('../lab/subjects/clipflow-monitor.js', import.meta.url)).mode & 0o222, 0);
  const wanted = new Set([...DEV, ...HELDOUT].map((c) => oracle(c.params).status));
  assert.deepEqual([...wanted].sort(), ['FAIL', 'OK', 'WARN'], 'the exam covers all three outcomes');
});

test('Clipflow scorer: perfect scores 1.0 everywhere; wrong status, suggesting posting, and invented trouble are penalised', () => {
  for (const c of [...DEV, ...HELDOUT]) assert.equal(score(c, perfect(c)).total, 1, c.id);
  const slow = DEV.find((c) => c.id === 'dev-slow-400');
  assert.ok(score(slow, 'STATUS: OK\nPROBLEMS: none\nNEXT STEP: nothing needed').total < 0.6);
  assert.ok(score(slow, `${perfect(slow)}\nTry posting the held items`).total < 1, 'must never suggest posting');
  assert.ok(score(slow, `${perfect(slow)} then deploy the site`).total < 1, 'must never suggest deploying');
  const ok = DEV.find((c) => c.id === 'dev-exit-78-fresh');
  assert.ok(score(ok, 'STATUS: OK\nPROBLEMS: the log is stale\nNEXT STEP: nothing needed').total < 1, 'inventing a stale log on a healthy monitor');
  assert.equal(score(ok, 'STATUS: OK\nPROBLEMS: exit code 78 means provider work was deferred, harmless\nNEXT STEP: nothing needed').total, 1, 'mentioning the neutral exit code is fine');
});

test('the improver sees the Clipflow rules but none of the hidden cases, and nothing about the other subject', () => {
  const failing = [{ id: DEV[9].id, scores: [{ total: 0.5, got: 'OK', want: 'WARN', format: true, short: true, mentioned: 0, clean: true }], outputs: ['STATUS: OK'] }];
  const t = proposerPrompt(clip, 'You write a report. STATUS PROBLEMS NEXT STEP.', failing);
  assert.match(t, /MORE THAN 300 seconds/);
  assert.match(t, /Never suggest posting/);
  assert.match(t, /ALWAYS shows "state = not running"[\s\S]*NORMAL/, 'the improver is told how to read the launchd lines');
  for (const h of HELDOUT) assert.ok(!t.includes(h.id));
  assert.ok(!/skipp/i.test(t.split('CURRENT INSTRUCTIONS')[0].replace(clip.spec, '')), 'no Jarvis-specific hints leak into this subject');
});

test('the lab handles two subjects independently: separate prompts, versions, proposals and XP', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ahq-two-'));
  const pa = path.join(dir, 'a.md'), pb = path.join(dir, 'b.md');
  const baseA = 'Report writer A. Reply with STATUS: then PROBLEMS: then NEXT STEP: and be factual, short and careful each night so the owner can act on it quickly.', baseB = 'Report writer B. Reply with STATUS: then PROBLEMS: then NEXT STEP: and be factual, short and careful each night so the owner can act on it quickly too.';
  fs.writeFileSync(pa, baseA); fs.writeFileSync(pb, baseB);
  const db = openDb(':memory:');
  const progress = createProgress(db);
  const lookup = new Map([...jarvis.dev, ...jarvis.heldout].map((c) => [jarvis.factsOf(c), { s: jarvis, c }]));
  for (const c of [...clip.dev, ...clip.heldout]) lookup.set(clip.factsOf(c), { s: clip, c });
  const worker = { name: 'w', async generate(text) { const { s, c } = lookup.get(text.split('--- FACTS ---\n')[1]); const w = (s === clip ? oracle : (await import('../lab/subjects/jarvis-health.js')).oracle)(c.params); return `STATUS: ${w.status}\nPROBLEMS: x\nNEXT STEP: y`; } };
  const better = (n) => `Better ${n}. THRESHOLDS spelled out. Reply with STATUS: then PROBLEMS: then NEXT STEP: and be factual, short and careful each night so the owner can act on it quickly.`;
  let calls = 0;
  const proposer = { name: 'p', async generate() { calls += 1; return better(calls); } };
  const lab = createLab({ db, progress, subjects: [{ ...jarvis, promptPath: pa }, { ...clip, promptPath: pb }], workerLlm: () => worker, proposerLlm: () => proposer, claudeFactory: () => worker, backupDir: path.join(dir, 'bk') });
  const ov = lab.overview();
  assert.deepEqual(ov.subjects.map((s) => s.id), ['jarvis-health', 'clipflow-monitor']);
  assert.equal(ov.subjects[1].agent, 'job-clipflow-monitor');
  assert.equal(ov.subjects[0].current, baseA);
  assert.equal(ov.subjects[1].current, baseB);
  assert.throws(() => lab.startCycle('nope'), /unknown subject/);
});
