import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const DAY = 24 * 60 * 60 * 1000;

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS agents(
      id TEXT PRIMARY KEY, name TEXT, role TEXT, kind TEXT, state TEXT, detail TEXT,
      since INTEGER, updated INTEGER, meta TEXT);
    CREATE TABLE IF NOT EXISTS events(
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, agent_id TEXT, kind TEXT, summary TEXT);
    CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
    CREATE TABLE IF NOT EXISTS action_log(
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, action TEXT, params TEXT, ok INTEGER, message TEXT);
    CREATE TABLE IF NOT EXISTS ledger(
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, agent_id TEXT NOT NULL, kind TEXT NOT NULL,
      xp INTEGER NOT NULL DEFAULT 0, verdict TEXT, source TEXT NOT NULL, ref TEXT, revoked INTEGER NOT NULL DEFAULT 0);
    CREATE UNIQUE INDEX IF NOT EXISTS ledger_ref ON ledger(agent_id, kind, ref) WHERE ref IS NOT NULL;
    CREATE INDEX IF NOT EXISTS ledger_agent ON ledger(agent_id, id);
  `);

  const getAgent = db.prepare('SELECT * FROM agents WHERE id = ?');
  const putAgent = db.prepare(
    `INSERT INTO agents(id,name,role,kind,state,detail,since,updated,meta) VALUES(?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, role=excluded.role, kind=excluded.kind, state=excluded.state,
       detail=excluded.detail, since=excluded.since, updated=excluded.updated, meta=excluded.meta`
  );
  const putEvent = db.prepare('INSERT INTO events(ts,agent_id,kind,summary) VALUES(?,?,?,?)');
  const delAgent = db.prepare('DELETE FROM agents WHERE id = ?');

  function addEvent(ts, agentId, kind, summary) {
    putEvent.run(ts, agentId, kind, String(summary).slice(0, 200));
  }

  return {
    raw: db,

    /** Store a snapshot. Records an event when the state changes. Returns true if the state changed. */
    upsert(a, now = Date.now()) {
      const prev = getAgent.get(a.id);
      const changed = !prev || prev.state !== a.state;
      const since = changed ? now : prev.since;
      if (changed) {
        const from = prev ? prev.state : 'appeared';
        addEvent(now, a.id, 'state', `${a.name}: ${from} -> ${a.state}${a.detail ? ` (${a.detail})` : ''}`);
      }
      putAgent.run(a.id, a.name, a.role, a.kind, a.state, a.detail, since, now, JSON.stringify(a.meta || {}));
      return changed;
    },

    /** Remove dynamic agents (like Claude sessions) that are no longer present. */
    removeMissing(prefix, currentIds, now = Date.now()) {
      const keep = new Set(currentIds);
      for (const row of db.prepare('SELECT id, name FROM agents WHERE id LIKE ?').all(`${prefix}%`)) {
        if (!keep.has(row.id)) {
          delAgent.run(row.id);
          addEvent(now, row.id, 'state', `${row.name}: ended`);
        }
      }
    },

    agents() {
      return db
        .prepare('SELECT * FROM agents ORDER BY kind, name')
        .all()
        .map((r) => ({ ...r, meta: safeJson(r.meta) }));
    },

    events(limit = 50) {
      const n = Math.max(1, Math.min(200, Number(limit) || 50));
      return db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(n);
    },

    logAction(action, params, ok, message, now = Date.now()) {
      db.prepare('INSERT INTO action_log(ts,action,params,ok,message) VALUES(?,?,?,?,?)').run(
        now, action, JSON.stringify(params ?? {}).slice(0, 500), ok ? 1 : 0, String(message).slice(0, 300)
      );
    },

    actionLog(limit = 30) {
      return db.prepare('SELECT * FROM action_log ORDER BY id DESC LIMIT ?').all(Math.max(1, Math.min(200, limit)));
    },

    prune(keepDays = 7, now = Date.now()) {
      db.prepare('DELETE FROM events WHERE ts < ?').run(now - keepDays * DAY);
    },

    close() {
      db.close();
    },
  };
}

function safeJson(s) {
  try {
    return JSON.parse(s || '{}');
  } catch {
    return {};
  }
}
