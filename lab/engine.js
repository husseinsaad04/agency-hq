// The improvement engine (reflect -> propose -> test -> strict gate). Pure logic plus injected models, so it is unit-tested.
// Safety by construction: the proposer returns TEXT only; only this module's validated text can ever become a proposal.

export const LIMITS = {
  maxPromptChars: 2200,
  minPromptChars: 200,
  repeats: 2, // each case is run twice and averaged, because model output varies
  maxCandidates: 2,
  maxCalls: 240, // hard budget of model calls per cycle
  devMargin: 0.03, // must beat the baseline on the dev cases by at least this much
  maxSeconds: 30 * 60,
};

const REQUIRED = [/STATUS/, /PROBLEMS/, /NEXT STEP/, /FACTS/i]; // the report format AND the framing that points the writer at the facts
const FORBIDDEN = /https?:\/\/|\b(curl|wget|sudo|ssh|rm\s+-rf|chmod|api[_ -]?key|password|token)\b|ignore (all|any|previous)|system prompt/i;

/** A proposed prompt must be plain instructions of sane size, keep the report format, and contain nothing dangerous. */
export function validateCandidate(base, cand) {
  const text = String(cand || '').trim();
  if (text.length < LIMITS.minPromptChars) return { ok: false, why: 'too short' };
  if (text.length > LIMITS.maxPromptChars) return { ok: false, why: 'too long' };
  if (text === String(base).trim()) return { ok: false, why: 'unchanged' };
  for (const re of REQUIRED) if (!re.test(text)) return { ok: false, why: `missing ${re.source}` };
  if (FORBIDDEN.test(text)) return { ok: false, why: 'contains forbidden content' };
  if (/```/.test(text)) return { ok: false, why: 'contains a code block' };
  return { ok: true };
}

/** Run a prompt over cases (each repeated), returning mean score and the share of fully-correct cases. */
export async function evaluate(subject, promptText, cases, llm, { repeats = LIMITS.repeats, budget, onProgress = () => {} } = {}) {
  const perCase = [];
  for (const c of cases) {
    const scores = [];
    const outputs = [];
    for (let r = 0; r < repeats; r++) {
      if (budget && budget.calls >= budget.max) throw Object.assign(new Error('call budget used up'), { budget: true });
      if (budget) budget.calls += 1;
      const out = await llm.generate(subject.compose(promptText, subject.factsOf(c)));
      outputs.push(out);
      scores.push(subject.score(c, out));
    }
    const mean = scores.reduce((a, s) => a + s.total, 0) / scores.length;
    perCase.push({ id: c.id, mean, strict: scores.every((s) => s.total >= 0.99), scores, outputs });
    onProgress(c.id, mean);
  }
  const n = perCase.length || 1;
  return { mean: perCase.reduce((a, x) => a + x.mean, 0) / n, strict: perCase.filter((x) => x.strict).length / n, perCase };
}

/** Build the "what went wrong" request for the proposing model (reflection on real failures). */
export function proposerPrompt(subject, current, failing) {
  const shown = failing.slice(0, 4).map((f, i) => {
    const c = subject.dev.find((x) => x.id === f.id);
    const worst = f.scores.reduce((a, b) => (b.total < a.total ? b : a));
    const reply = String(f.outputs[f.scores.indexOf(worst)] || '').slice(0, 500);
    return `EXAMPLE ${i + 1}\nFacts given:\n${subject.factsOf(c)}\nCorrect STATUS: ${worst.want}\nThe writer replied:\n${reply}\nWhat was wrong: ${worst.got === worst.want ? 'status was right but ' : `it said STATUS ${worst.got || 'nothing'}; `}${worst.format ? '' : 'the three-line format was broken; '}${worst.mentioned < 1 ? 'it did not name the real cause; ' : ''}${worst.short ? '' : 'it was too long; '}${worst.clean ? '' : 'it invented a problem or suggested changing privacy settings; '}`;
  }).join('\n\n');
  const spec = subject.spec ? `\n\nTHE OWNER'S OFFICIAL RULES. The improved instructions must make the writer follow these exactly. Never change a threshold, never add a rule that is not listed here:\n${subject.spec}` : '';
  return `You improve written instructions for an AI that turns raw computer health facts into a short report.${spec}\n\nCURRENT INSTRUCTIONS:\n<<<\n${current.trim()}\n>>>\n\nHere are cases where the report writer got it wrong:\n\n${shown}\n\nMake the SMALLEST edit that fixes these failures. Keep the opening lines that explain the task, keep the sentence telling the writer to use only the facts below the line FACTS, and keep the report format block exactly. Add or correct only the rules that are missing or wrong, and do not delete anything useful. State clear, explicit rules (every threshold, and exactly what counts as OK, WARN or FAIL). Keep the report format with the lines STATUS:, PROBLEMS: and NEXT STEP:. Rules for your answer: plain text only, no code blocks, no links, at most ${LIMITS.maxPromptChars - 400} characters. Reply with ONLY the new instructions and nothing else.`;
}

/** Clean the model's reply into a prompt (drop wrappers like <<< >>> or code fences). */
export function parseCandidate(reply) {
  let t = String(reply || '').trim();
  t = t.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').replace(/^<<<\s*/, '').replace(/\s*>>>$/, '').trim();
  return t;
}

/** The strict gate. An improvement must be real on the dev cases AND not worse on the held-out cases. */
export function gate(base, cand) {
  const reasons = [];
  if (cand.dev.mean < base.dev.mean + LIMITS.devMargin) reasons.push(`dev score ${fmt(cand.dev.mean)} is not at least ${LIMITS.devMargin} better than ${fmt(base.dev.mean)}`);
  if (cand.held.mean < base.held.mean) reasons.push(`held-out score dropped (${fmt(base.held.mean)} -> ${fmt(cand.held.mean)})`);
  // An improvement that does not carry over to cases the improver never saw may just be memorised.
  else if (base.held.mean < 0.99 && cand.held.mean <= base.held.mean) reasons.push('held-out cases did not improve, so this may be memorised rather than learned');
  if (cand.held.strict < base.held.strict) reasons.push('fewer held-out cases are fully correct');
  if (cand.dev.strict < base.dev.strict) reasons.push('fewer dev cases are fully correct');
  return { pass: reasons.length === 0, reasons };
}
const fmt = (x) => (Math.round(x * 1000) / 1000).toFixed(3);

/** Plain line diff (longest common subsequence) so you can read exactly what would change. */
export function diffLines(a, b) {
  const A = String(a).split('\n'), B = String(b).split('\n');
  const dp = Array.from({ length: A.length + 1 }, () => new Array(B.length + 1).fill(0));
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < A.length && j < B.length) {
    if (A[i] === B[j]) { out.push({ t: 'same', text: A[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ t: 'del', text: A[i++] });
    else out.push({ t: 'add', text: B[j++] });
  }
  while (i < A.length) out.push({ t: 'del', text: A[i++] });
  while (j < B.length) out.push({ t: 'add', text: B[j++] });
  return out;
}

/**
 * One improvement cycle. Never writes anything itself: it returns what it found.
 * Returns { outcome: 'proposal'|'no_improvement'|'already_perfect', baseline, best?, tried, calls, notes[] }
 */
export async function runCycle(subject, current, { worker, proposer, log = () => {}, maxCandidates = LIMITS.maxCandidates, repeats = LIMITS.repeats, maxCalls = LIMITS.maxCalls, now = Date.now } = {}) {
  const started = now();
  const budget = { calls: 0, max: maxCalls };
  const notes = [];
  const attempts = []; // every attempt is kept so a failed cycle can be understood, not just discarded
  const keep = (n, text, outcome, dev, held) => attempts.push({ n, text: String(text || '').slice(0, LIMITS.maxPromptChars), outcome, dev: dev ?? null, held: held ?? null });
  const over = () => (now() - started) / 1000 > LIMITS.maxSeconds;

  log(`Scoring the current prompt on ${subject.dev.length} practice cases…`);
  const baseDev = await evaluate(subject, current, subject.dev, worker, { budget, repeats, onProgress: (id, m) => log(`  ${id}: ${m.toFixed(2)}`) });
  log(`Scoring the current prompt on ${subject.heldout.length} hidden cases…`);
  const baseHeld = await evaluate(subject, current, subject.heldout, worker, { budget, repeats });
  const baseline = { dev: summary(baseDev), held: summary(baseHeld) };
  log(`Baseline: practice ${baseline.dev.mean.toFixed(3)} (${pct(baseline.dev.strict)} perfect), hidden ${baseline.held.mean.toFixed(3)} (${pct(baseline.held.strict)} perfect).`);

  const failing = baseDev.perCase.filter((x) => !x.strict).sort((a, b) => a.mean - b.mean);
  if (!failing.length) return { outcome: 'already_perfect', baseline, tried: 0, attempts, calls: budget.calls, notes: ['Every practice case is already fully correct.'] };

  let best = null;
  let tried = 0;
  for (let k = 0; k < maxCandidates; k++) {
    if (over()) { notes.push('stopped: time limit'); break; }
    tried += 1;
    log(`Asking the improver for a better prompt (attempt ${k + 1}, it sees ${Math.min(4, failing.length)} failures)…`);
    let reply;
    try {
      budget.calls += 1;
      reply = await proposer.generate(proposerPrompt(subject, current, failing), { timeoutMs: 240000 });
    } catch (e) { notes.push(`improver failed: ${e.message}`); keep(k + 1, '', `improver failed: ${e.message}`); continue; }
    const text = parseCandidate(reply);
    const v = validateCandidate(current, text);
    if (!v.ok) { notes.push(`attempt ${k + 1} rejected before testing: ${v.why}`); log(`  rejected before testing: ${v.why}`); keep(k + 1, text, `rejected before testing: ${v.why}`); continue; }
    try {
      log('  testing it on the practice cases…');
      const dev = summary(await evaluate(subject, text, subject.dev, worker, { budget, repeats }));
      if (dev.mean < baseline.dev.mean + LIMITS.devMargin) { notes.push(`attempt ${k + 1}: practice score ${dev.mean.toFixed(3)} did not beat ${baseline.dev.mean.toFixed(3)}`); log(`  no better on practice cases (${dev.mean.toFixed(3)}).`); keep(k + 1, text, 'no better on the practice cases', dev.mean); continue; }
      log('  testing it on the hidden cases…');
      const held = summary(await evaluate(subject, text, subject.heldout, worker, { budget, repeats }));
      const g = gate(baseline, { dev, held });
      if (!g.pass) { notes.push(`attempt ${k + 1} failed the gate: ${g.reasons.join('; ')}`); log(`  failed the gate: ${g.reasons.join('; ')}`); keep(k + 1, text, `failed the gate: ${g.reasons.join('; ')}`, dev.mean, held.mean); continue; }
      log(`  PASSED: practice ${dev.mean.toFixed(3)}, hidden ${held.mean.toFixed(3)}.`);
      keep(k + 1, text, 'passed the gate', dev.mean, held.mean);
      if (!best || held.mean > best.held.mean || (held.mean === best.held.mean && text.length < best.text.length)) best = { text, dev, held };
    } catch (e) {
      notes.push(e.budget ? 'stopped: call budget used up' : `testing failed: ${e.message}`);
      if (e.budget) break;
    }
  }
  if (best) return { outcome: 'proposal', baseline, best, tried, attempts, calls: budget.calls, notes };
  return { outcome: 'no_improvement', baseline, tried, attempts, calls: budget.calls, notes };
}

const summary = (e) => ({ mean: e.mean, strict: e.strict, cases: e.perCase.map((c) => ({ id: c.id, mean: Math.round(c.mean * 1000) / 1000 })) });
const pct = (x) => `${Math.round(x * 100)}%`;
