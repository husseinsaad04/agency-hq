// Level system. XP comes ONLY from verified results, and every award is a row in an append-only ledger.
//
//   +50 XP  you pressed "Good result" on that agent (a human verdict; agents cannot press it)
//   +10 XP  a test run passed (auto-verified, small, capped per session and per day)
//   + 5 XP  a nightly check finished with STATUS OK (once per job per day)
//
// Never XP for: messages, tool calls, tokens, uptime, lines of code, files touched, or state changes.
// The game is a read-only view: nothing here is ever fed back to an agent as a goal or reward.
import { ROSTER } from './registry.js';

export const XP = { human_approve: 50, human_reject: 0, tests_pass: 10, tests_fail: 0, job_ok: 5, lab_approve: 50 };
export const LIMITS = {
  testsPerSessionPerDay: 3, // at most 3 test-pass awards per Claude session per day
  testsPerAgentPerDay: 10,
  testGapMs: 20_000, // re-running tests within 20 s of the last award earns nothing
  failsPerSessionPerDay: 10,
  approvalsPerAgentPerHour: 10, // guards against fat-fingering or mashing the button
  undoWindowMs: 5 * 60 * 1000,
  verdictWindow: 40, // rank looks at the last 40 verdicts
};

/** Total XP needed to REACH level n (level 1 = 0 XP). Early levels come fast, later ones are earned. */
export const need = (n) => Math.round(100 * Math.pow(n - 1, 1.5));

export function levelFor(xp) {
  let level = 1;
  while (need(level + 1) <= xp) level += 1;
  return { level, floor: need(level), next: need(level + 1) };
}

/** Rank comes from the rolling pass rate (not from XP), so it can go down. verdicts = ['pass'|'fail', ...] */
export function rankFor(verdicts) {
  const n = verdicts.length;
  const rate = n ? verdicts.filter((v) => v === 'pass').length / n : 0;
  if (n < 5) return 'Intern';
  if (n >= 40 && rate >= 0.9) return 'Staff';
  if (n >= 20 && rate >= 0.8) return 'Senior';
  if (n >= 10 && rate >= 0.7) return 'Engineer';
  if (rate >= 0.5) return 'Junior';
  return 'Intern';
}

/** Claude sessions and their sub-agents all roll up to the Claude Code agent. */
export const creditId = (id) => (/^(claude|sub):/.test(String(id)) ? 'claude-code' : String(id));
export const isRateable = (id) => Object.prototype.hasOwnProperty.call(ROSTER, creditId(id));

const dayStart = (now) => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); };

export function createProgress(db) {
  const raw = db.raw;
  const insert = raw.prepare('INSERT INTO ledger(ts,agent_id,kind,xp,verdict,source,ref) VALUES(?,?,?,?,?,?,?)');
  const count = raw.prepare('SELECT COUNT(*) c FROM ledger WHERE agent_id=? AND kind=? AND revoked=0 AND ts>=? AND (? IS NULL OR ref LIKE ?)');
  const lastTs = raw.prepare('SELECT MAX(ts) t FROM ledger WHERE agent_id=? AND kind=? AND ref LIKE ?');

  function add(e, now) {
    try {
      const r = insert.run(now, e.agent, e.kind, e.xp, e.verdict ?? null, e.source, e.ref ?? null);
      return Number(r.lastInsertRowid);
    } catch {
      return null; // duplicate ref (already awarded)
    }
  }

  return {
    /** A test run finished in a Claude session. Pass earns small capped XP, fail only affects rank. */
    recordTest(session, ok, now = Date.now()) {
      const agent = 'claude-code';
      const pre = `s:${session}:%`;
      const since = dayStart(now);
      if (!ok) {
        if (count.get(agent, 'tests_fail', since, pre, pre).c >= LIMITS.failsPerSessionPerDay) return { awarded: 0, reason: 'cap' };
        add({ agent, kind: 'tests_fail', xp: 0, verdict: 'fail', source: 'hook', ref: `s:${session}:${now}` }, now);
        return { awarded: 0, reason: 'fail' };
      }
      if (count.get(agent, 'tests_pass', since, pre, pre).c >= LIMITS.testsPerSessionPerDay) return { awarded: 0, reason: 'session cap' };
      if (count.get(agent, 'tests_pass', since, null, null).c >= LIMITS.testsPerAgentPerDay) return { awarded: 0, reason: 'daily cap' };
      const last = lastTs.get(agent, 'tests_pass', pre).t;
      if (last && now - last < LIMITS.testGapMs) return { awarded: 0, reason: 'too soon' };
      add({ agent, kind: 'tests_pass', xp: XP.tests_pass, verdict: 'pass', source: 'hook', ref: `s:${session}:${now}` }, now);
      return { awarded: XP.tests_pass, reason: 'ok' };
    },

    /** A nightly job report. Only STATUS OK earns XP, once per job per day. */
    recordJob(agent, date, status, now = Date.now()) {
      if (status !== 'OK' || !isRateable(agent)) return { awarded: 0 };
      const id = add({ agent, kind: 'job_ok', xp: XP.job_ok, verdict: 'pass', source: 'report', ref: `${agent}:${date}` }, now);
      return { awarded: id ? XP.job_ok : 0 };
    },

    /** YOU judge an agent's work. This is the strongest signal, and only your browser can send it. */
    humanVerdict(agentId, verdict, now = Date.now()) {
      if (!isRateable(agentId)) throw new Error('unknown agent');
      if (verdict !== 'approve' && verdict !== 'reject') throw new Error('invalid verdict');
      const agent = creditId(agentId);
      const kind = verdict === 'approve' ? 'human_approve' : 'human_reject';
      const hourAgo = now - 3600_000;
      if (raw.prepare("SELECT COUNT(*) c FROM ledger WHERE agent_id=? AND source='human' AND revoked=0 AND ts>=?").get(agent, hourAgo).c >= LIMITS.approvalsPerAgentPerHour) throw new Error('slow down: too many verdicts for this agent this hour');
      const id = add({ agent, kind, xp: XP[kind], verdict: verdict === 'approve' ? 'pass' : 'fail', source: 'human' }, now);
      return { id, xp: XP[kind], agent };
    },

    /** You approved an agent's self-improvement (a reviewed prompt change). One award per proposal. */
    recordLab(agentId, proposalId, now = Date.now()) {
      if (!isRateable(agentId)) throw new Error('unknown agent');
      const id = add({ agent: creditId(agentId), kind: 'lab_approve', xp: XP.lab_approve, verdict: 'pass', source: 'human', ref: `proposal:${proposalId}` }, now);
      return { id, xp: id ? XP.lab_approve : 0 };
    },

    /** An approved improvement was later reverted: it no longer counts. */
    revokeRef(agentId, kind, ref) {
      return raw.prepare('UPDATE ledger SET revoked=1 WHERE agent_id=? AND kind=? AND ref=?').run(creditId(agentId), kind, ref).changes > 0;
    },

    /** Take back a human verdict made in the last 5 minutes (the row stays, but stops counting). */
    undo(id, now = Date.now()) {
      const row = raw.prepare('SELECT * FROM ledger WHERE id=?').get(id);
      if (!row || row.source !== 'human' || row.revoked) return false;
      if (now - row.ts > LIMITS.undoWindowMs) return false;
      raw.prepare('UPDATE ledger SET revoked=1 WHERE id=?').run(id);
      return true;
    },

    summary() {
      const rows = raw.prepare('SELECT agent_id, SUM(xp) xp FROM ledger WHERE revoked=0 GROUP BY agent_id').all();
      const progress = {};
      let total = 0;
      for (const r of rows) {
        const verdicts = raw.prepare('SELECT verdict FROM ledger WHERE agent_id=? AND verdict IS NOT NULL AND revoked=0 ORDER BY id DESC LIMIT ?').all(r.agent_id, LIMITS.verdictWindow).map((v) => v.verdict).reverse();
        const lv = levelFor(r.xp);
        total += r.xp;
        progress[r.agent_id] = { xp: r.xp, ...lv, rank: rankFor(verdicts), verdicts: verdicts.length, passRate: verdicts.length ? verdicts.filter((v) => v === 'pass').length / verdicts.length : null };
      }
      return { progress, studio: { xp: total, ...levelFor(total) } };
    },

    recent(agentId, limit = 6) {
      return raw.prepare('SELECT id, ts, kind, xp, verdict, source, revoked FROM ledger WHERE agent_id=? ORDER BY id DESC LIMIT ?').all(creditId(agentId), Math.max(1, Math.min(50, limit)));
    },
  };
}

export const KIND_TEXT = { human_approve: 'you approved the result', human_reject: 'you rejected the result', tests_pass: 'tests passed (auto)', tests_fail: 'tests failed (auto)', job_ok: 'nightly check OK', lab_approve: 'you approved its self-improvement' };
