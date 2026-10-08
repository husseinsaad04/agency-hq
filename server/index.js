import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from './config.js';
import { openDb } from './db.js';
import { collectAll } from './collector.js';
import { createActions } from './actions.js';
import { createApp } from './app.js';
import { createProgress } from './progress.js';
import { createLab } from './lab.js';
import { ollamaLlm, claudeLlm } from '../lab/llm.js';
import jarvisHealth from '../lab/subjects/jarvis-health.js';
import clipflowMonitor from '../lab/subjects/clipflow-monitor.js';
import { createTasks } from './tasks.js';
import { createCompany } from './company.js';
import {createProjectChat} from './project-chat.js';
import { createPaperclip, loadPaperclipConnection } from './paperclip.js';
import {loadPhoneAccess} from './phone-access.js';
import {createStaticPreviews} from './static-preview.js';
import {createBrowserChecker} from './browser-check.js';

const webDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const db = openDb(path.join(CONFIG.dataDir, 'agency.db'));
const actions = createActions({ db });
const paperclipConnection = loadPaperclipConnection();
const previews=createStaticPreviews({db});
const tasks = createTasks({ db, preparePreview:project=>previews.ensure(project), extraSkills: () => paperclipConnection?.roles || [] });
const paperclip = createPaperclip({ db, tasks, connection: paperclipConnection });
const company = createCompany({ db, tasks });
const browserEvidence = createBrowserChecker();
const projectChat = createProjectChat({db,tasks,preparePreview:project=>previews.ensure(project),browserEvidence});
const progress = createProgress(db);
// Self-improvement lab: the improving model only ever returns text; it is the local model (free, private).
const lab = createLab({
  db, progress, subjects: [jarvisHealth, clipflowMonitor],
  workerLlm: () => ollamaLlm({ temperature: 0.2, numPredict: 350 }),
  proposerLlm: () => ollamaLlm({ temperature: 0.7, numPredict: 700 }),
  claudeFactory: (model = 'haiku') => claudeLlm({ model }),
  backupDir: path.join(CONFIG.dataDir, 'lab-backups'),
});
// Secret that lets the Claude Code hook script (and only it) report activity. Stored 0600 in the data dir.
const tokenFile = path.join(CONFIG.dataDir, 'hook-token');
if (!fs.existsSync(tokenFile)) fs.writeFileSync(tokenFile, crypto.randomBytes(24).toString('hex'), { mode: 0o600 });
const hookToken = fs.readFileSync(tokenFile, 'utf8').trim();
const phoneAccess = loadPhoneAccess(path.join(CONFIG.dataDir,'phone-access.json'));
const app = createApp({ db, actions, tasks, company, projectChat, previews, paperclip, webDir, pollMs: CONFIG.pollMs, hookToken, progress, lab, phoneAccess });

let collecting = false;
async function tick() {
  if (collecting) return;
  collecting = true;
  try {
    await collectAll(db, { progress });
  } catch (e) {
    console.error('collect failed:', e.message);
  } finally {
    collecting = false;
  }
}

await tick();
const timer = setInterval(tick, CONFIG.pollMs);
paperclip.sync();
const paperclipTimer = setInterval(() => paperclip.sync(), 5000);
const projectChatTimer = setInterval(()=>projectChat.tick(),2000);

app.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${CONFIG.port} is already in use. Is Agency HQ already running?` : e.message);
  process.exit(1);
});
app.listen(CONFIG.port, CONFIG.host, () => {
  console.log(`Agency HQ running at http://127.0.0.1:${CONFIG.port}  (localhost only)`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    clearInterval(timer);
    clearInterval(paperclipTimer);
    clearInterval(projectChatTimer);
    projectChat.close();
    tasks.close();
    previews.close();
    app.close();
    db.close();
    process.exit(0);
  });
}
