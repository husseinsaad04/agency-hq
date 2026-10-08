// Stage-handoff protocol markers. Shared by the server and the browser (pure, dependency-free). Only real marker lines count: code fences, quotes and
// prose mentions never advance a stage; contradictory YES/NO markers never read as ready.
const FENCE = /^\s*(```|~~~)/;
const MARKER = /^\s*(?:[-*+]\s+|\d+[.)]\s+)?(?:\*\*|__)?(HANDOFF_READY|CHECKS_PASSED|HUMAN_REQUIRED|REPAIR_RESOLVED|BROWSER_UNAVAILABLE)(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*(YES|NO)\b(?:\*\*|__)?(?:\s*(?:[-–—:(].*|\*.*))?\s*$/i;
const GAPS = /^\s*(?:[-*+]\s+)?(?:\*\*|__)?OPTIONAL_GAPS(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*(.*?)\s*$/i;
const PROVIDER_BLOCK = /\b(?:subscription quota|quota reached|rate limit|usage limit|subscription limit|authentication required|login required|sign in required|permission denied|operation not permitted|listen EPERM|payment required|captcha|credentials required|accept terms)\b/i;

export function markers(report = '') {
  const found = { HANDOFF_READY: [], CHECKS_PASSED: [], HUMAN_REQUIRED: [], REPAIR_RESOLVED: [], BROWSER_UNAVAILABLE: [] };
  let fenced = false;
  for (const line of String(report).split('\n')) {
    if (FENCE.test(line)) { fenced = !fenced; continue; }
    if (fenced || /^\s*>/.test(line)) continue;
    const m = MARKER.exec(line);
    if (m) found[m[1].toUpperCase()].push(m[2].toUpperCase());
  }
  return found;
}
// 'YES' | 'NO' | 'CONFLICT' | null (absent)
export function decision(report, name) {
  const v = new Set(markers(report)[name]);
  return v.size === 0 ? null : v.size > 1 ? 'CONFLICT' : [...v][0];
}
export const isReady = report => decision(report, 'HANDOFF_READY') === 'YES';
export const checksPassed = report => decision(report, 'CHECKS_PASSED') === 'YES';
export const repairResolved = report => decision(report, 'REPAIR_RESOLVED') === 'YES';
// An explicit HUMAN_REQUIRED decision is authoritative; provider phrases are only a fallback
// for reports that carry no decision, and never inside code fences or quotes.
export function humanBlock(report = '') {
  const d = decision(report, 'HUMAN_REQUIRED');
  if (d === 'YES' || d === 'CONFLICT') return true;
  if (d === 'NO') return false;
  let fenced = false;
  const prose = String(report).split('\n').filter(l => { if (FENCE.test(l)) { fenced = !fenced; return false; } return !fenced && !/^\s*>/.test(l); }).join('\n');
  return PROVIDER_BLOCK.test(prose);
}
export const isMarkerLine = line => MARKER.test(line) || GAPS.test(line);
// Optional, non-blocking gaps (e.g. an unavailable browser mode). Never a readiness or human-block signal.
export function optionalGaps(report = '') {
  const out = []; let fenced = false;
  for (const line of String(report).split('\n')) {
    if (FENCE.test(line)) { fenced = !fenced; continue; }
    if (fenced || /^\s*>/.test(line)) continue;
    const m = GAPS.exec(line); if (m && m[1].trim()) out.push(m[1].trim());
  }
  return out;
}
// The worker had no usable browser. That is a missing capability, not an owner/provider block.
const BROWSER_ABSENT = /\b(?:no (?:usable |available )?browser|browser (?:tool|tools|capabilit\w*|access)\b[^.\n]{0,40}(?:unavailable|not available|absent|missing)|playwright[^.\n]{0,120}(?:EPERM|failed|denied|unavailable)|browser (?:checks|acceptance)[^.\n]{0,60}blocked)/i;
const OWNER_BLOCK = /\b(?:subscription quota|quota reached|rate limit|usage limit|subscription limit|authentication required|login required|sign in required|payment required|captcha|credentials required|accept terms)\b/i;
export const providerBlocked = report => OWNER_BLOCK.test(String(report));
export const browserUnavailable = report => decision(report, 'BROWSER_UNAVAILABLE') === 'YES' || (decision(report, 'BROWSER_UNAVAILABLE') !== 'NO' && BROWSER_ABSENT.test(String(report)));
