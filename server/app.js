import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { listProjects } from './actions.js';
import { validatePayload } from './sanitize.js';
import { activity } from './activity.js';
import { KIND_TEXT } from './progress.js';
import {phoneRequest,validatePhoneAccess} from './phone-access.js';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const STATIC = new Set(['/', '/index.html', '/app.js', '/style.css', '/office.js', '/office-logic.js', '/missions.js', '/task-summary.js', '/protocol.js', '/project-chat.js', '/company.js', '/paperclip.js', '/tower.js', '/building-3d.js', '/spatial-logic.js', '/vendor/three.module.js', '/vendor/three.core.js', '/vendor/OrbitControls.js', '/vendor/three-LICENSE.txt']);
const COUNT_KEYS = ['working', 'waiting', 'running', 'scheduled', 'idle', 'standby', 'stopped', 'error', 'unknown'];

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'X-Frame-Options': 'DENY',
};

export function summarize(agents) {
  const counts = Object.fromEntries(COUNT_KEYS.map((k) => [k, 0]));
  for (const a of agents) counts[a.state] = (counts[a.state] || 0) + 1;
  return counts;
}

export function createApp({ db, actions, tasks = null, company = null, projectChat = null, previews = null, paperclip = null, webDir, pollMs = 3000, hookToken = '', tracker = activity, progress = null, lab = null, phoneAccess = null }) {
  const phone = phoneAccess ? validatePhoneAccess(phoneAccess) : null;
  const nonce = crypto.randomBytes(16).toString('hex');
  const boot = crypto.randomBytes(8).toString('hex'); // public per-process id so open tabs can detect a restart; never accepted as auth
  let server;

  const hostOk = (host) => {
    const port = server.address()?.port;
    return host === `127.0.0.1:${port}` || host === `localhost:${port}` || (phone && host === phone.host);
  };
  const originOk = (origin, req) => {
    const port = server.address()?.port;
    if(phoneRequest(req,phone).remote) return phoneRequest(req,phone).allowed && origin === phone.origin;
    return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
  };

  const prog = () => (progress ? progress.summary() : { progress: {}, studio: null });
  /** Browser-only POST guard: right origin AND the secret nonce that only our own page receives. */
  const browserOk = (req, res) => {
    if (!originOk(String(req.headers.origin || ''), req)) { send(res, 403, { error: 'bad origin' }); return false; }
    if (req.headers['x-ahq-nonce'] !== nonce) { send(res, 403, { error: 'bad nonce' }); return false; }
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) { send(res, 415, { error: 'json only' }); return false; }
    return true;
  };

  const send = (res, code, body, headers = {}) => {
    const isStr = typeof body === 'string';
    res.writeHead(code, { ...SECURITY_HEADERS, 'Content-Type': isStr ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', ...headers });
    res.end(isStr ? body : JSON.stringify(body));
  };

  async function readJson(req, limit = 8192) {
    let size = 0;
    const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > limit) throw Object.assign(new Error('body too large'), { status: 413 });
      chunks.push(c);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      throw Object.assign(new Error('invalid json'), { status: 400 });
    }
  }

  async function handle(req, res) {
    const phoneAuth = phoneRequest(req,phone);
    if (!phoneAuth.allowed) return send(res,403,'Private HQ access requires your Tailscale account.');
    if (!hostOk(String(req.headers.host || ''))) return send(res, 403, 'bad host');
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (phoneAuth.remote && p === '/api/hook') return send(res,403,'Local hook only');

    // ---- static files
    if (req.method === 'GET' && STATIC.has(p)) {
      const file = p === '/' ? 'index.html' : p.slice(1);
      let body = await fs.readFile(path.join(webDir, file), 'utf8');
      if (file === 'index.html') body = body.replace('__NONCE__', nonce).replace('__BOOT__', boot);
      return send(res, 200, body, { 'Content-Type': TYPES[path.extname(file)] });
    }

    if (req.method === 'GET' && p === '/api/paperclip') return send(res,200,paperclip ? paperclip.overview() : {configured:false,roles:[],links:[]});

    // Company operating model: all mutations share the existing browser guard.
    if(req.method==='GET'&&p==='/api/project-chat')return send(res,200,{jobs:projectChat?.list()||[],projects:tasks?.catalog().projects||[]});
    const evMatch=/^\/api\/project-chat\/([a-f0-9-]{36})\/evidence\/([a-z]+-\d+\.png)$/.exec(p);
    if(req.method==='GET'&&evMatch){const file=projectChat?.evidenceFile(evMatch[1],evMatch[2]);if(!file)return send(res,404,{error:'not found'});try{const img=await fs.readFile(file);res.writeHead(200,{...SECURITY_HEADERS,'Content-Type':'image/png','Cache-Control':'no-store'});return res.end(img);}catch{return send(res,404,{error:'not found'});}}
    const chatMatch=/^\/api\/project-chat\/([a-f0-9-]{36})\/(resume|stop)$/.exec(p);
    if(req.method==='POST'&&(p==='/api/project-chat'||chatMatch)){
      if(!projectChat)return send(res,404,{error:'project chat unavailable'});
      if(!browserOk(req,res))return;
      const body=await readJson(req,8192);
      if(body.confirmed!==true)return send(res,400,{error:'confirmation required'});
      try{return send(res,200,{ok:true,job:chatMatch?projectChat[chatMatch[2]](chatMatch[1]):projectChat.create(body)});}catch(e){return send(res,400,{error:e.message});}
    }
    if (req.method === 'GET' && p === '/api/company') return company ? send(res, 200, { ...company.catalog(), jobs: company.list() }) : send(res, 404, {error:'company unavailable'});
    const skillExport=/^\/api\/company\/skills\/([a-z-]+)\/export$/.exec(p);
    if(req.method==='GET'&&company&&skillExport){
      const skill=company.catalog().roles.find(s=>s.id===skillExport[1]);
      if(!skill)return send(res,404,{error:'skill not found'});
      return send(res,200,`# ${skill.name}\n\n${skill.prompt}\n\nSource: HQ adaptation of the public AI Company Map.\n${company.catalog().source}\n`,{'Content-Disposition':`attachment; filename="${skill.id}.md"`});
    }
    if (req.method === 'GET' && p === '/api/brain') {
      if (!tasks) return send(res, 404, {error:'brain unavailable'});
      try {
        const project=url.searchParams.get('project');
        if (url.searchParams.get('export')==='1') return send(res,200,tasks.brain.export(project),{'Content-Disposition':'attachment; filename="shared-brain.md"'});
        return send(res,200,{notes:tasks.brain.list(project)});
      } catch(e) {return send(res,400,{error:e.message});}
    }
    const jobMatch=/^\/api\/company\/([a-f0-9-]{36})\/(advance|retry|stop)$/.exec(p);
    if (req.method === 'POST' && (p==='/api/company/route'||p==='/api/company/jobs'||p==='/api/brain'||p==='/api/brain/capture'||p==='/api/brain/archive'||jobMatch)) {
      if (!company || !tasks) return send(res,404,{error:'company unavailable'});
      if (!browserOk(req,res)) return;
      const body=await readJson(req,16384);
      try {
        if (p==='/api/company/route') {
          if(typeof body.goal!=='string'||body.goal.length>2000)throw new Error('Invalid objective');
          return send(res,200,company.route(body.goal));
        }
        if(body.confirmed!==true)return send(res,400,{error:'confirmation required'});
        if(p==='/api/company/jobs')return send(res,201,{ok:true,job:company.create(body)});
        if(p==='/api/brain')return send(res,200,{ok:true,note:tasks.brain.put(body)});
        if(p==='/api/brain/archive')return send(res,200,{ok:true,note:tasks.brain.archive(body.id,body.archived)});
        if(p==='/api/brain/capture') {
          const t=tasks.get(body.taskId);if(!t)throw new Error('Task not found');
          return send(res,200,{ok:true,note:tasks.brain.capture(t)});
        }
        return send(res,200,{ok:true,job:company[jobMatch[2]](jobMatch[1],body)});
      } catch(e) {return send(res,400,{ok:false,message:e.message});}
    }

    // ---- read-only API
    if (req.method === 'GET' && p === '/api/state') {
      const agents = db.agents();
      return send(res, 200, { now: Date.now(), agents, counts: summarize(agents), runs: actions.recentRuns(), ...prog() });
    }
    if (req.method === 'GET' && p === '/api/events') return send(res, 200, { events: db.events(url.searchParams.get('limit') || 50) });
    if (req.method === 'GET' && p === '/api/actionlog') return send(res, 200, { log: db.actionLog(30) });
    if (p === '/api/task-catalog' && req.method === 'GET') return tasks ? send(res, 200, tasks.catalog()) : send(res, 404, { error: 'tasks unavailable' });
    if (p === '/api/tasks' && req.method === 'GET') return send(res, 200, { tasks: tasks ? tasks.list().map(({ instructions, result, ...t }) => t) : [] });
    const taskMatch = /^\/api\/tasks\/([a-f0-9-]{36})(?:\/(cancel|retry|review|export|preview))?$/.exec(p);
    if (tasks && taskMatch && req.method === 'GET') {
      const t = tasks.detail(taskMatch[1]);
      if (!t) return send(res, 404, { error: 'task not found' });
      if (taskMatch[2] === 'export') return send(res, 200, `${t.title}\n${t.skillName} / ${t.runtime} / ${t.project}\nStatus: ${t.status}\n\n${t.result}\n\nTimeline\n${t.events.map(e => `${new Date(e.ts).toISOString()} ${e.kind}: ${e.text}`).join('\n')}`, { 'Content-Disposition': 'attachment; filename="agency-task.txt"' });
      if (taskMatch[2]) return send(res, 405, { error: 'POST required' });
      return send(res, 200, t);
    }
    if (req.method === 'POST' && (p === '/api/tasks' || p === '/api/skills' || taskMatch)) {
      if (!tasks) return send(res, 404, { error: 'tasks unavailable' });
      if (!browserOk(req, res)) return;
      const body = await readJson(req, 16384);
      try {
        if (p === '/api/skills') return send(res, 201, { ok: true, skill: tasks.addSkill(body) });
        if (body.confirmed !== true) return send(res, 400, { ok: false, message: 'confirmation required' });
        if (p === '/api/tasks') return send(res, 201, { ok: true, task: tasks.create(body) });
        const [, id, op] = taskMatch;
        if (op === 'preview') { // reopen the fixed, static, loopback-only preview of this task's project; no build, no commands
          const t = tasks.get(id); if (!t || !previews) return send(res, 404, { ok: false, message: 'preview unavailable' });
          const preview = await previews.ensure(t.project); if (!preview) return send(res, 404, { ok: false, message: 'This project has no static preview.' });
          db.logAction('preview.reopen', { id, project: t.project }, true, 'Local static preview reopened');
          return send(res, 200, { ok: true, preview });
        }
        if (!['cancel', 'retry', 'review'].includes(op)) return send(res, 405, { ok: false, message: 'invalid task action' });
        return send(res, 200, { ok: true, task: op === 'review' ? tasks.review(id, body.verdict) : tasks[op](id) });
      } catch (e) { return send(res, 400, { ok: false, message: e.message }); }
    }
    if (req.method === 'GET' && p === '/api/actions') return send(res, 200, { actions: actions.describe() });
    if (req.method === 'GET' && p === '/api/projects') return send(res, 200, { projects: listProjects() });
    if (req.method === 'GET' && /^\/api\/runs\/r\d+$/.test(p)) {
      const r = actions.getRun(p.split('/').pop());
      return r ? send(res, 200, r) : send(res, 404, { error: 'no such run' });
    }
    if (req.method === 'GET' && p === '/api/stream') {
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' });
      let last = '';
      const push = () => {
        const agents = db.agents();
        const pr = prog();
        const snap = JSON.stringify([agents.map((a) => [a.id, a.state, a.detail]), pr]);
        if (snap !== last) {
          last = snap;
          res.write(`event: state\ndata: ${JSON.stringify({ now: Date.now(), boot, agents, counts: summarize(agents), runs: actions.recentRuns(), ...pr })}\n\n`);
        } else res.write(': ping\n\n');
      };
      push();
      const t = setInterval(push, pollMs);
      req.on('close', () => clearInterval(t));
      return;
    }

    // ---- hook events from Claude Code (token-protected, tiny, strictly validated, never from browsers)
    if (req.method === 'POST' && p === '/api/hook') {
      if (req.headers.origin) return send(res, 403, { error: 'browsers not allowed' });
      const got = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
      const want = Buffer.from(String(hookToken || ''));
      if (!want.length || got.length !== want.length || !crypto.timingSafeEqual(got, want)) return send(res, 401, { error: 'unauthorized' });
      const clean = validatePayload(await readJson(req, 2048));
      if (!clean) return send(res, 400, { error: 'bad event' });
      if (clean.event === 'tool_ok' || clean.event === 'tool_fail') progress?.recordTest(clean.session, clean.event === 'tool_ok');
      else tracker.ingest(clean);
      res.writeHead(204, SECURITY_HEADERS);
      return res.end();
    }

    if (req.method === 'GET' && p === '/api/ledger') {
      const agent = url.searchParams.get('agent') || '';
      return send(res, 200, { entries: progress ? progress.recent(agent, 6).map((e) => ({ ...e, text: KIND_TEXT[e.kind] || e.kind })) : [] });
    }

    // ---- YOUR verdicts (the only strong XP source). Browser-only: agents cannot send these.
    if (req.method === 'POST' && p === '/api/verdict') {
      if (!browserOk(req, res)) return;
      const body = await readJson(req);
      try {
        const r = progress.humanVerdict(String(body.agent || ''), String(body.verdict || ''));
        return send(res, 200, { ok: true, id: r.id, xp: r.xp, agent: r.agent });
      } catch (e) {
        return send(res, 400, { ok: false, message: e.message });
      }
    }
    if (req.method === 'POST' && p === '/api/verdict/undo') {
      if (!browserOk(req, res)) return;
      const body = await readJson(req);
      return send(res, 200, { ok: Boolean(progress && progress.undo(Number(body.id))) });
    }

    // ---- self-improvement lab. Reads are open to the page; every change needs your browser's nonce AND confirmation.
    if (req.method === 'GET' && p === '/api/lab') return lab ? send(res, 200, lab.overview()) : send(res, 404, { error: 'lab not enabled' });
    if (req.method === 'GET' && p === '/api/lab/run') return send(res, 200, { run: lab ? lab.runState() : null });
    if (req.method === 'POST' && p.startsWith('/api/lab/')) {
      if (!lab) return send(res, 404, { error: 'lab not enabled' });
      if (!browserOk(req, res)) return;
      const body = await readJson(req);
      const needConfirm = p !== '/api/lab/decide' || body.decision === 'approve';
      if (needConfirm && body.confirmed !== true) return send(res, 400, { ok: false, message: 'confirmation required' });
      try {
        if (p === '/api/lab/run') return send(res, 200, { ok: true, ...lab.startCycle(String(body.subject || ''), { worker: String(body.worker || 'local') }) });
        if (p === '/api/lab/decide') return send(res, 200, lab.decide(Number(body.id), String(body.decision || '')));
        if (p === '/api/lab/revert') return send(res, 200, lab.revert(String(body.subject || '')));
        if (p === '/api/lab/verify') return send(res, 200, { ok: true, claude: await lab.verifyWithClaude(Number(body.id)) });
        return send(res, 404, { error: 'not found' });
      } catch (e) {
        return send(res, 400, { ok: false, message: e.message });
      }
    }

    // ---- actions (the only way to change anything)
    if (req.method === 'POST' && p === '/api/action') {
      if (!originOk(String(req.headers.origin || ''), req)) return send(res, 403, { error: 'bad origin' });
      if (req.headers['x-ahq-nonce'] !== nonce) return send(res, 403, { error: 'bad nonce' });
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) return send(res, 415, { error: 'json only' });
      const body = await readJson(req);
      const r = await actions.execute(String(body.id || ''), body.params || {}, { confirmed: body.confirmed === true });
      return send(res, r.status, { ok: r.ok, message: r.message, runId: r.runId });
    }

    return send(res, req.method === 'GET' ? 404 : 405, { error: 'not found' });
  }

  server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'server error' });
      else res.end();
    });
  });
  server.nonce = nonce;
  return server;
}
