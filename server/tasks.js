import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CONFIG, HOME } from './config.js';
import { resolveProject, listProjects } from './actions.js';
import { SKILLS, RUNTIMES } from './skills.js';
import { COMPANY_SKILLS } from './company-catalog.js';
import { createBrain } from './brain.js';
import { CODEX_TOOLKIT, CODEX_TOOL_INSTRUCTIONS, codexSubscriptionArgs, codexSubscriptionEnv } from './codex-subscription.js';

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
export function redact(text) {
  return String(text || '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\b(?:sk-[\w-]{12,}|gh[pousr]_[\w]{15,})\b/g, '[redacted]').replace(/\b(api[_-]?key|authorization|password|token|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]');
}
export function eventSummary(e) {
  const i = e.item;
  if (i && /reasoning/.test(i.type || '')) return null;
  if (i?.type === 'command_execution') return { kind: 'tool', text: `${e.type === 'item.started' ? 'Running' : `Finished${i.exit_code != null ? ` (exit ${i.exit_code})` : ''}`} command: ${i.command || ''}` };
  if (i?.type === 'file_change') return { kind: 'file', text: `Changed ${(i.changes || []).map(x => path.basename(x.path)).join(', ')}` };
  if (i?.type === 'mcp_tool_call') return { kind: 'tool', text: `${i.server || 'MCP'}: ${i.tool || 'tool'} · ${i.status || e.type}` };
  if (i?.type === 'web_search') return { kind: 'tool', text: `Web search: ${i.query || ''}` };
  if (i?.type === 'agent_message') return { kind: 'message', text: i.text || '' };
  if (e.type === 'assistant') {
    const blocks = e.message?.content || [];
    const tool = blocks.find(b => b.type === 'tool_use');
    if (tool) return { kind: 'tool', text: `Using ${tool.name}${tool.input?.file_path ? ': ' + path.basename(tool.input.file_path) : tool.input?.query ? ': ' + tool.input.query : ''}` };
    const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n');
    return text ? { kind: 'message', text } : null;
  }
  if (e.type === 'result') return { kind: e.is_error ? 'error' : 'result', text: e.result || (e.permission_denials?.length ? 'Permission requests were denied.' : 'Agent returned a result.') };
  if (e.type === 'error' || e.type === 'turn.failed') return { kind: 'error', text: e.message || e.error?.message || 'Agent execution failed.' };
  return null;
}

export function createTasks({ db, spawn = nodeSpawn, root = CONFIG.projectsDir, dataDir = CONFIG.dataDir, home = HOME, extraSkills = () => [], preparePreview = null, previewTimeoutMs = 15000, maxConcurrent = 2, timeoutMs = 30 * 60 * 1000, now = Date.now } = {}) {
  const sql = db.raw;
  sql.exec(`CREATE TABLE IF NOT EXISTS hq_tasks(id TEXT PRIMARY KEY, record TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS hq_task_events(id INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT,ts INTEGER,kind TEXT,text TEXT);
    CREATE INDEX IF NOT EXISTS hq_task_events_task ON hq_task_events(task_id,id);
    CREATE TABLE IF NOT EXISTS hq_skills(id TEXT PRIMARY KEY,record TEXT NOT NULL);`);
  const brain = createBrain({ db, root, now });
  const active = new Map();
  let closed = false;
  const get = id => { const r = sql.prepare('SELECT record FROM hq_tasks WHERE id=?').get(id); return r ? JSON.parse(r.record) : null; };
  const list = () => sql.prepare('SELECT record FROM hq_tasks ORDER BY rowid DESC LIMIT 200').all().map(r => JSON.parse(r.record));
  const save = t => { t.updatedAt = now(); sql.prepare('INSERT INTO hq_tasks VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record').run(t.id, JSON.stringify(t)); };
  const skills = () => [...SKILLS, ...COMPANY_SKILLS, ...extraSkills(), ...sql.prepare('SELECT record FROM hq_skills ORDER BY rowid').all().map(r => JSON.parse(r.record))];
  const addEvent = (id, kind, text) => sql.prepare('INSERT INTO hq_task_events(task_id,ts,kind,text) VALUES(?,?,?,?)').run(id, now(), kind, redact(text).slice(0, 8000));
  const signalGroup = (child, signal) => { try { if (child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch { try { child.kill(signal); } catch {} } };
  const updateAgent = t => db.upsert({ id: `hq:${t.id}`, name: `${t.skillName} · ${t.title}`, role: `${t.runtime} / ${t.project}`, kind: 'session', state: t.status === 'running' ? 'working' : t.status === 'review' && !t.reviewOptional ? 'waiting' : 'idle', detail: t.activity || t.status, meta: { taskId: t.id, cwd: path.join(root, t.project) } });
  function finish(id, status, note) {
    const slot = active.get(id);
    if (!slot) return;
    clearTimeout(slot.timer); clearTimeout(slot.killTimer);
    const t = get(id);
    if (TERMINAL.has(t.status) || t.status === 'review') return;
    t.status = status; t.endedAt = now(); t.activity = note;
    save(t); addEvent(id, status, note); updateAgent(t);
    active.delete(id); queueMicrotask(pump);
  }
  function launch(t) {
    let dir;
    try { dir = resolveProject(t.project, root); } catch (e) { t.status = 'failed'; t.activity = e.message; save(t); addEvent(t.id, 'error', e.message); return; }
    const skill = skills().find(s => s.id === t.skill);
    const shared = brain.context(t.project);
    t.knowledgeIds = shared.ids;
    let prompt = `${t.runtime === 'codex' ? CODEX_TOOL_INSTRUCTIONS : ''}\n\n${skill.prompt}\n\n${shared.text}\n\nTask: ${t.title}\nProject: ${dir}\nAccess: ${t.mode}\nInstructions:\n${t.instructions}\n\nWork only on this request. Do not read credentials, change other projects, send communications, publish, deploy, or commit. Explain tool or permission blocks. Return a concise final report, at most 160 words before optional Details. Use these exact headings on separate lines: Outcome, Checks, Next step. Outcome: what you delivered in one or two sentences. Checks: actual checks and results, distinguishing failed or blocked checks. Next step: what needs owner attention or remains blocked. Always include an explicit HANDOFF_READY: YES or HANDOFF_READY: NO decision in the final report. YES means the assigned deliverable and its required checks are complete within the authorized scope; NO means unfinished work, failed or blocked checks, or unresolved requirements. Explain a NO decision briefly. Do not infer readiness from approval or successful execution alone. Do not recount your steps. Put supporting file references and extended evidence under Details only if needed. Never imply deployed or posted from local tests. ${t.mode === 'read-only' ? 'Do not modify project files.' : 'Keep all file changes inside the selected project.'}`;
    let file, args, cwd = dir;
    if (t.runtime === 'codex') {
      file = '/opt/homebrew/bin/codex';
      args = codexSubscriptionArgs(t.mode,dir);
      t.toolkit = CODEX_TOOLKIT.id; t.billingMode = 'chatgpt-subscription';
    } else if (t.runtime === 'claude') {
      file = path.join(home, '.local/bin/claude');
      args = ['-p', '--verbose', '--output-format', 'stream-json', '--restricted', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--tools', 'Read,Glob,Grep,WebSearch,WebFetch', '--allowedTools', 'Read,Glob,Grep,WebSearch,WebFetch'];
    } else {
      file = '/opt/homebrew/bin/ruflo';
      cwd = path.join(dataDir, 'ruflo-runs', t.id); fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
      const bin = path.join(cwd, 'bin'); fs.mkdirSync(bin, { mode: 0o700 });
      const quote = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
      // Ruflo discovers this wrapper through PATH, so its Claude child keeps the same read-only tool policy.
      fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\nexec ${quote(path.join(home, '.local/bin/claude'))} --restricted --strict-mcp-config --add-dir ${quote(dir)} --permission-mode dontAsk --permission-prompts none --tools Read,Glob,Grep,WebSearch,WebFetch --allowedTools Read,Glob,Grep,WebSearch,WebFetch "$@"\n`, { mode: 0o700 });
      fs.writeFileSync(path.join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { ruflo: { command: file, args: ['mcp', 'start'] } } }), { mode: 0o600 });
      args = ['hive-mind', 'init', '--max-agents', '3'];
    }
    t.status = 'running'; t.startedAt = now(); t.activity = 'Starting agent'; save(t); updateAgent(t); addEvent(t.id, 'started', `${t.runtime} started in ${t.mode} mode`);
    if(t.runtime === 'codex')addEvent(t.id,'tools','Codex subscription toolkit · ChatGPT login required · live web search · existing Codex tools and plugins · API-key fallback disabled');
    const slot = { child: null, timer: null, killTimer: null, buffer: '', streamError: false, sawResult: false, stderr: '', timedOut: false };
    active.set(t.id, slot);
    const observe = line => {
      let e; try { e = JSON.parse(line); } catch { return; }
      if (e.usage || e.total_cost_usd != null) {
        const task = get(t.id);
        task.usage = { inputTokens: e.usage?.input_tokens ?? null, outputTokens: e.usage?.output_tokens ?? null, reportedCostUsd: e.total_cost_usd ?? null };
        save(task);
      }
      if (e.type === 'result') {
        slot.sawResult = true;
        if (e.is_error || e.permission_denials?.length) slot.streamError = true;
        if (e.result) { const task = get(t.id); task.result = redact(e.result).slice(-40000); save(task); }
      }
      if (e.type === 'turn.completed') slot.sawResult = true;
      if (e.type === 'error' || e.type === 'turn.failed') slot.streamError = true;
      const summary = eventSummary(e);
      if (!summary) return;
      addEvent(t.id, summary.kind, summary.text);
      const task = get(t.id);
      task.activity = redact(summary.text).slice(0, 180);
      if (summary.kind === 'message') task.result = (task.result + '\n\n' + redact(summary.text)).slice(-40000);
      if (summary.kind === 'error') slot.streamError = true;
      save(task); updateAgent(task);
    };
    const start = (command, argv, stage = 'run') => {
      try {
        const child = spawn(command, argv, { cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...(t.runtime === 'codex' ? codexSubscriptionEnv(process.env) : process.env), PATH: `${t.runtime === 'ruflo' ? path.join(cwd, 'bin') + ':' : ''}${path.join(home, '.local/bin')}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin` } });
        slot.child = child;
        child.stdout?.on('data', data => {
          slot.buffer += String(data);
          const lines = slot.buffer.split('\n'); slot.buffer = lines.pop().slice(-262144);
          for (const line of lines) observe(line);
        });
        child.stderr?.on('data', data => { slot.stderr = (slot.stderr + redact(data)).slice(-2000); });
        child.on('error', e => finish(t.id, 'failed', `Could not launch ${t.runtime}: ${e.message}`));
        child.on('close', code => {
          if (active.get(t.id) !== slot) return;
          if (slot.buffer) observe(slot.buffer); slot.buffer = '';
          if (get(t.id).status === 'cancelling') { finish(t.id, slot.timedOut ? 'failed' : 'cancelled', slot.timedOut ? 'Time budget reached. Review the partial result before retrying.' : 'Task cancelled by you.'); return; }
          if (stage === 'init' && code === 0) {
            start(file, ['hive-mind', 'spawn', '--claude', '--non-interactive', '--no-auto-permissions', '--count', '2', '--type', 'researcher', '--mcp-config', path.join(cwd, '.mcp.json'), '--objective', prompt]); return;
          }
          const ok = code === 0 && !slot.streamError && slot.sawResult;
          finish(t.id, ok ? 'review' : 'failed', ok ? 'Result ready for your review.' : (slot.stderr || 'Agent did not complete successfully. Check the timeline for provider or permission errors.'));
        });
        if (t.runtime !== 'ruflo') child.stdin?.end(prompt);
        else child.stdin?.end();
        child.stdin?.on('error', () => {});
      } catch (e) { finish(t.id, 'failed', e.message); }
    };
    slot.timer = setTimeout(() => {
      slot.timedOut = true;
      addEvent(t.id, 'timeout', 'Time budget reached; stopping the agent.');
      const task = get(t.id); task.status = 'cancelling'; save(task);
      if (!slot.child) { finish(t.id, 'failed', 'Time budget reached before the worker started.'); return; }
      signalGroup(slot.child, 'SIGTERM');
      slot.killTimer = setTimeout(() => signalGroup(slot.child, 'SIGKILL'), 5000);
    }, Math.min(timeoutMs, t.budgetMinutes * 60000));
    if(t.runtime==='codex'&&preparePreview){
      const launchWithPreview=preview=>{
        if(active.get(t.id)!==slot)return;
        if(get(t.id).status==='cancelling'){finish(t.id,slot.timedOut?'failed':'cancelled',slot.timedOut?'Time budget reached.':'Task cancelled by you.');return;}
        if(preview){const current=get(t.id);current.preview=preview;save(current);addEvent(t.id,'preview',`HQ prepared a local static preview: ${preview.url}`);prompt+=`\nHQ static preview: ${preview.url}\nOpen this exact URL first; do not append /dist/ because the built directory is already served at the root. HQ serves only static files from this project. Sandbox permissions are unchanged. Use an available browser tool to perform actual acceptance checks. Rebuild changed source before checking built output. This does not execute server code or replace database/API verification. Do not try to start your own listener when this static preview is sufficient. Do not claim browser checks passed merely because the preview exists. Script-free fallback view: ${preview.scriptFreeUrl||preview.url+'__hq-noscript/'} . This test response omits scripts and enforces script-src none; it tests rendered static fallback without changing browser JavaScript settings. Prefer ordinary navigation, DOM, screenshots, keyboard and supported viewport controls. Do not request raw developer/CDP access or change browser permissions for optional tests. Report the exact test method and any gaps. A denied optional capability does not prevent independent permitted checks, but never retry the denied action or claim it passed.`;}
        start(file,args);
      };
      let prepTimer;const bounded=new Promise(r=>{prepTimer=setTimeout(()=>r(null),previewTimeoutMs);});
      Promise.race([Promise.resolve().then(()=>preparePreview(t.project)),bounded]).finally(()=>clearTimeout(prepTimer)).then(launchWithPreview).catch(()=>launchWithPreview(null));
    }else start(file, args, t.runtime === 'ruflo' ? 'init' : 'run');
  }
  function pump() {
    if (closed) return;
    const projects = new Set([...active.keys()].map(id => get(id).project));
    for (const t of list().reverse()) {
      if (active.size >= maxConcurrent) break;
      if (t.status !== 'queued' || projects.has(t.project)) continue;
      projects.add(t.project); launch(t);
    }
  }
  // Never silently replay previously submitted work after a crash/restart.
  for (const t of list()) if (['running', 'queued', 'cancelling'].includes(t.status)) {
    t.status = 'interrupted'; t.activity = 'HQ restarted. Review the partial result and retry explicitly.'; t.endedAt = now(); save(t); addEvent(t.id, 'interrupted', t.activity); updateAgent(t);
  }
  return {
    list, get, skills, brain,
    catalog: () => ({ skills: skills(), runtimes: RUNTIMES, projects: listProjects(root), maxConcurrent, codexToolkit: CODEX_TOOLKIT }),
    // Follow supersededBy links to the latest applicable assignment; history is never rewritten.
    current(id) { const seen = new Set(); let t = get(id); while (t?.supersededBy && !seen.has(t.id)) { seen.add(t.id); const n = get(t.supersededBy); if (!n) break; t = n; } return t ? t.id : null; },
    detail(id) { const t = get(id); return t ? { ...t, currentId: this.current(id), events: sql.prepare('SELECT ts,kind,text FROM hq_task_events WHERE task_id=? ORDER BY id DESC LIMIT 100').all(id).reverse() } : null; },
    create(input) {
      if (closed) throw new Error('Task runner is stopping');
      if (!input || typeof input !== 'object') throw new Error('invalid task');
      const text = (key, max) => { const v = input[key]; if (typeof v !== 'string' || !v.trim() || v.length > max) throw new Error(`invalid ${key}`); return v.trim(); };
      const title = text('title', 100), instructions = text('instructions', 6000);
      const skill = skills().find(s => s.id === input.skill), runtime = RUNTIMES.find(r => r.id === input.runtime);
      const budgetMinutes = input.budgetMinutes ?? 20;
      if (!Number.isInteger(budgetMinutes) || budgetMinutes < 1 || budgetMinutes > 30) throw new Error('Time budget must be 1–30 minutes');
      if (!skill || !runtime || !runtime.modes.includes(input.mode)) throw new Error('invalid skill, runtime, or access mode');
      resolveProject(input.project, root);
      if (list().filter(t => ['queued','running','cancelling'].includes(t.status)).length >= 20) throw new Error('Queue is full (20 tasks)');
      const t = { id: crypto.randomUUID(), title, instructions, project: input.project, skill: skill.id, skillName: skill.name, runtime: runtime.id, mode: input.mode, budgetMinutes, status: 'queued', createdAt: now(), startedAt: null, endedAt: null, activity: 'Waiting for a worker and project slot', result: '', review: null, ...(skill.paperclipAgentId ? {paperclipAgentId:skill.paperclipAgentId,paperclipCompanyId:skill.paperclipCompanyId} : {}) };
      save(t); addEvent(t.id, 'queued', 'Task queued from HQ'); db.logAction('task.create', { id:t.id, runtime:t.runtime, project:t.project, chars:instructions.length }, true, 'queued'); queueMicrotask(pump); return t;
    },
    cancel(id) {
      const t = get(id); if (!t || !['queued','running','cancelling'].includes(t.status)) throw new Error('Task is not active');
      if (t.status === 'queued') { t.status = 'cancelled'; t.endedAt = now(); t.activity = 'Cancelled before starting'; save(t); addEvent(id, 'cancelled', t.activity); return t; }
      const slot = active.get(id); t.status = 'cancelling'; t.activity = 'Stopping agent…'; save(t); addEvent(id, 'cancelling', t.activity);
      if (slot && !slot.child) { finish(id, 'cancelled', 'Task cancelled by you.'); return get(id); }
      if (slot && !slot.killTimer) { signalGroup(slot.child, 'SIGTERM'); slot.killTimer = setTimeout(() => signalGroup(slot.child, 'SIGKILL'), 5000); }
      return t;
    },
    review(id, verdict, source = 'owner') {
      const t = get(id); if (!t || t.status !== 'review' || !['approved','changes-requested'].includes(verdict)) throw new Error('Invalid task review');
      t.status = 'completed'; t.review = verdict; t.reviewSource = source; if (source !== 'project-policy') t.reviewOptional = false; t.activity = source === 'project-policy' ? verdict === 'approved' ? 'Handoff accepted under your automatic project setting; final delivery still needs review.' : 'Automatic review requested repairs. This is not an approved handoff.' : verdict === 'approved' ? 'Approved by you.' : 'Changes requested. Create a follow-up assignment.'; save(t); addEvent(id, 'review', verdict); updateAgent(t); return t;
    },
    markDelivered(id) {const t=get(id);if(!t||t.status!=='review')throw Error('Delivery result is not ready');t.reviewOptional=true;t.activity='Project delivered. Optional owner review available.';save(t);addEvent(id,'delivered',t.activity);updateAgent(t);return t;},
    supersede(id,replacementId) {const t=get(id),replacement=get(replacementId);if(!t||t.status!=='review'||!replacement||replacement.project!==t.project)throw Error('Invalid superseded assignment');this.review(id,'changes-requested','project-policy');const updated=get(id);updated.supersededBy=replacementId;updated.activity='Earlier attempt superseded by a newer project assignment. This is not an approved handoff.';save(updated);addEvent(id,'superseded',replacementId);updateAgent(updated);return updated;},
    retry(id) { const t = get(id); if (!t || !TERMINAL.has(t.status)) throw new Error('Task must finish before retrying'); return this.create(t); },
    addSkill(input) {
      if (!input || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 60 || typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 4000) throw new Error('Skill needs a name (60 chars) and instructions (4000 chars)');
      if (sql.prepare('SELECT COUNT(*) AS n FROM hq_skills').get().n >= 30) throw new Error('Custom skill library is full (30 skills)');
      const s = { id: `custom-${crypto.randomUUID()}`, name: input.name.trim(), role: 'Custom Specialist', icon: '✦', description: 'Your reusable task instructions', prompt: input.prompt.trim(), example: '' };
      sql.prepare('INSERT INTO hq_skills VALUES(?,?)').run(s.id, JSON.stringify(s)); return s;
    },
    close() { closed = true; for (const [id,s] of active) { signalGroup(s.child, 'SIGKILL'); finish(id, 'interrupted', 'HQ stopped. Retry explicitly when ready.'); } },
  };
}
