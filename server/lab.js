// Self-improvement lab manager: proposals, versions, deploy, revert. Nothing deploys without your decision.
import fs from 'node:fs';
import path from 'node:path';
import { runCycle, validateCandidate, diffLines, evaluate } from '../lab/engine.js';

export function createLab({ db, progress, subjects, workerLlm, proposerLlm, claudeFactory, backupDir, now = Date.now }) {
  const raw = db.raw;
  raw.exec(`
    CREATE TABLE IF NOT EXISTS lab_proposals(
      id INTEGER PRIMARY KEY AUTOINCREMENT, subject TEXT NOT NULL, ts INTEGER NOT NULL, status TEXT NOT NULL,
      base_text TEXT NOT NULL, cand_text TEXT NOT NULL, metrics TEXT NOT NULL, diff TEXT NOT NULL, decided_ts INTEGER, note TEXT);
    CREATE TABLE IF NOT EXISTS lab_versions(
      id INTEGER PRIMARY KEY AUTOINCREMENT, subject TEXT NOT NULL, ts INTEGER NOT NULL, text TEXT NOT NULL, source TEXT NOT NULL, proposal_id INTEGER);
    CREATE TABLE IF NOT EXISTS lab_runs(
      id INTEGER PRIMARY KEY AUTOINCREMENT, subject TEXT NOT NULL, ts INTEGER NOT NULL, outcome TEXT NOT NULL, summary TEXT NOT NULL);
  `);
  const byId = new Map(subjects.map((s) => [s.id, s]));
  let running = null; // the cycle in progress, or the last one that finished
  const live = (s) => fs.readFileSync(s.promptPath, 'utf8');
  const need = (id) => { const s = byId.get(id); if (!s) throw new Error('unknown subject'); return s; };
  const json = (s) => { try { return JSON.parse(s); } catch { return null; } };

  function ensureVersions(s) {
    const text = live(s);
    const last = raw.prepare('SELECT * FROM lab_versions WHERE subject=? ORDER BY id DESC LIMIT 1').get(s.id);
    if (!last) raw.prepare('INSERT INTO lab_versions(subject,ts,text,source) VALUES(?,?,?,?)').run(s.id, now(), text, 'original');
    else if (last.text.trim() !== text.trim()) raw.prepare('INSERT INTO lab_versions(subject,ts,text,source) VALUES(?,?,?,?)').run(s.id, now(), text, 'edited outside the lab');
    return text;
  }

  function writeLive(s, text) {
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    fs.copyFileSync(s.promptPath, path.join(backupDir, `${s.id}-${now()}.md`)); // backup first
    const tmp = `${s.promptPath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${text.trim()}\n`);
    fs.renameSync(tmp, s.promptPath); // atomic swap
  }

  const proposalRow = (r) => (r ? { id: r.id, subject: r.subject, ts: r.ts, status: r.status, decidedTs: r.decided_ts, note: r.note, metrics: json(r.metrics), diff: json(r.diff), candidate: r.cand_text } : null);

  return {
    overview() {
      return {
        running: running ? { subject: running.subject, status: running.status, startedAt: running.startedAt } : null,
        subjects: subjects.map((s) => {
          const text = ensureVersions(s);
          const versions = raw.prepare('SELECT id, ts, source, proposal_id FROM lab_versions WHERE subject=? ORDER BY id DESC LIMIT 8').all(s.id);
          const lastRun = raw.prepare('SELECT ts, outcome, summary FROM lab_runs WHERE subject=? ORDER BY id DESC LIMIT 1').get(s.id);
          return {
            id: s.id, name: s.name, agent: s.agent, describe: s.describe, practiceCases: s.dev.length, hiddenCases: s.heldout.length,
            current: text, versionCount: raw.prepare('SELECT COUNT(*) c FROM lab_versions WHERE subject=?').get(s.id).c, versions,
            canRevert: versions.length >= 2,
            lastRun: lastRun ? { ts: lastRun.ts, outcome: lastRun.outcome, summary: json(lastRun.summary) } : null,
            proposals: raw.prepare('SELECT * FROM lab_proposals WHERE subject=? ORDER BY id DESC LIMIT 6').all(s.id).map(proposalRow),
          };
        }),
      };
    },

    runState() {
      return running ? { subject: running.subject, worker: running.worker || null, status: running.status, startedAt: running.startedAt, endedAt: running.endedAt || null, log: running.log.slice(-60), error: running.error || null, outcome: running.outcome || null } : null;
    },

    /** Start a cycle in the background (one at a time). Returns immediately. */
    startCycle(subjectId, { worker = 'local' } = {}) {
      if (worker !== 'local' && worker !== 'claude') throw new Error('invalid worker');
      const s = need(subjectId);
      if (running && running.status === 'running') throw new Error('a cycle is already running');
      const current = ensureVersions(s);
      const state = { subject: s.id, status: 'running', startedAt: now(), log: [] };
      running = state;
      const log = (m) => state.log.push(`${new Date().toLocaleTimeString()}  ${m}`);
      const useClaude = worker === 'claude';
      const testTaker = useClaude ? claudeFactory('sonnet') : workerLlm();
      state.worker = testTaker.name;
      log(`Test-taker: ${testTaker.name}${useClaude ? ' (your Claude plan is used)' : ' (free, local)'}`);
      (async () => {
        try {
          const r = await runCycle(s, current, { worker: testTaker, proposer: proposerLlm(), log, repeats: useClaude ? 1 : undefined, maxCalls: useClaude ? 130 : undefined });
          let proposalId = null;
          if (r.outcome === 'proposal') {
            const metrics = { baseline: r.baseline, dev: r.best.dev, held: r.best.held, calls: r.calls, notes: r.notes, model: testTaker.name };
            proposalId = Number(raw.prepare('INSERT INTO lab_proposals(subject,ts,status,base_text,cand_text,metrics,diff) VALUES(?,?,?,?,?,?,?)').run(s.id, now(), 'pending', current, r.best.text, JSON.stringify(metrics), JSON.stringify(diffLines(current, r.best.text))).lastInsertRowid);
            log(`A proposal is ready for your review (#${proposalId}).`);
          } else log(r.outcome === 'already_perfect' ? 'Nothing to improve: every practice case is already correct.' : `No improvement passed the strict gate. ${r.notes.join(' | ')}`);
          raw.prepare('INSERT INTO lab_runs(subject,ts,outcome,summary) VALUES(?,?,?,?)').run(s.id, now(), r.outcome, JSON.stringify({ baseline: r.baseline, tried: r.tried, calls: r.calls, notes: r.notes, proposalId, attempts: r.attempts }));
          state.outcome = r.outcome;
          state.status = 'done';
        } catch (e) {
          state.status = 'error';
          state.error = /fetch failed|ECONNREFUSED|ollama/i.test(e.message) ? 'The local model (Ollama) is not answering. Start it from the Ollama card, then try again.' : e.message;
          log(`Stopped: ${state.error}`);
        } finally {
          state.endedAt = now();
        }
      })();
      return { started: true };
    },

    /** YOUR decision. Approve deploys the new prompt (with a backup); reject just records it. */
    decide(proposalId, decision) {
      const row = raw.prepare('SELECT * FROM lab_proposals WHERE id=?').get(proposalId);
      if (!row) throw new Error('no such proposal');
      if (row.status !== 'pending') throw new Error(`already ${row.status}`);
      const s = need(row.subject);
      if (decision === 'reject') {
        raw.prepare("UPDATE lab_proposals SET status='rejected', decided_ts=? WHERE id=?").run(now(), proposalId);
        return { ok: true, status: 'rejected' };
      }
      if (decision !== 'approve') throw new Error('invalid decision');
      const current = live(s);
      if (current.trim() !== row.base_text.trim()) {
        raw.prepare("UPDATE lab_proposals SET status='stale', decided_ts=? WHERE id=?").run(now(), proposalId);
        throw new Error('the live prompt changed since this was proposed, so it was NOT deployed. Run a new cycle.');
      }
      const v = validateCandidate(row.base_text, row.cand_text); // re-check at the moment of deployment
      if (!v.ok) throw new Error(`proposal no longer passes the safety check (${v.why})`);
      writeLive(s, row.cand_text);
      raw.prepare("UPDATE lab_proposals SET status='approved', decided_ts=? WHERE id=?").run(now(), proposalId);
      raw.prepare('INSERT INTO lab_versions(subject,ts,text,source,proposal_id) VALUES(?,?,?,?,?)').run(s.id, now(), row.cand_text.trim(), 'lab', proposalId);
      const xp = progress ? progress.recordLab(s.agent, proposalId, now()).xp : 0;
      return { ok: true, status: 'approved', xp };
    },

    /** Put the previous version back (and take back the XP it earned). */
    revert(subjectId) {
      const s = need(subjectId);
      ensureVersions(s);
      const [latest, previous] = raw.prepare('SELECT * FROM lab_versions WHERE subject=? ORDER BY id DESC LIMIT 2').all(s.id);
      if (!previous) throw new Error('there is no earlier version to go back to');
      writeLive(s, previous.text);
      raw.prepare('INSERT INTO lab_versions(subject,ts,text,source,proposal_id) VALUES(?,?,?,?,?)').run(s.id, now(), previous.text.trim(), 'revert', null);
      if (latest.proposal_id) {
        raw.prepare("UPDATE lab_proposals SET status='reverted' WHERE id=?").run(latest.proposal_id);
        if (progress) progress.revokeRef(s.agent, 'lab_approve', `proposal:${latest.proposal_id}`);
      }
      return { ok: true };
    },

    /** Optional: re-score old vs new with real Claude (uses your plan, so the API asks you first). */
    async verifyWithClaude(proposalId) {
      const row = raw.prepare('SELECT * FROM lab_proposals WHERE id=?').get(proposalId);
      if (!row) throw new Error('no such proposal');
      const s = need(row.subject);
      const llm = claudeFactory('haiku');
      const cases = [...s.dev, ...s.heldout];
      const budget = { calls: 0, max: cases.length * 2 };
      const oldR = await evaluate(s, row.base_text, cases, llm, { repeats: 1, budget });
      const newR = await evaluate(s, row.cand_text, cases, llm, { repeats: 1, budget });
      const claude = { model: llm.name, calls: budget.calls, old: { mean: oldR.mean, strict: oldR.strict }, new: { mean: newR.mean, strict: newR.strict } };
      const metrics = json(row.metrics) || {};
      metrics.claude = claude;
      raw.prepare('UPDATE lab_proposals SET metrics=? WHERE id=?').run(JSON.stringify(metrics), proposalId);
      return claude;
    },
  };
}
