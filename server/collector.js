import * as claude from './adapters/claude.js';
import * as docker from './adapters/docker.js';
import * as launchd from './adapters/launchd.js';
import * as ollama from './adapters/ollama.js';
import * as cli from './adapters/cli.js';
import * as cloud from './adapters/cloud.js';
import { unknownFor } from './registry.js';

export const ADAPTERS = [claude, docker, launchd, ollama, cli, cloud];

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}

/** Run every adapter once, store results, return the full agent list. One broken adapter never breaks the rest. */
export async function collectAll(db, { adapters = ADAPTERS, now = Date.now(), timeoutMs = 5000, progress = null } = {}) {
  const results = await Promise.all(
    adapters.map(async (a) => {
      try {
        return await withTimeout(a.collect(), timeoutMs);
      } catch (e) {
        return unknownFor(a.staticIds, e.message);
      }
    })
  );
  const all = results.flat();
  for (const agent of all) db.upsert(agent, now);
  db.removeMissing('claude:', all.filter((a) => a.id.startsWith('claude:')).map((a) => a.id), now);
  db.removeMissing('sub:', all.filter((a) => a.id.startsWith('sub:')).map((a) => a.id), now);
  if (progress) for (const a of all) if (a.id.startsWith('job-') && a.meta && a.meta.report) progress.recordJob(a.id, a.meta.report.date, a.meta.report.status, now);
  db.prune(7, now);
  return db.agents();
}
