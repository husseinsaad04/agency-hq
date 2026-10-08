import os from 'node:os';
import path from 'node:path';

export const HOME = os.homedir();

export const CONFIG = {
  host: '127.0.0.1', // never change: localhost only
  port: Number(process.env.AHQ_PORT || 7777),
  dataDir: process.env.AHQ_DATA || path.join(HOME, '.agency-hq'),
  projectsDir: process.env.AHQ_PROJECTS || path.join(HOME, 'Projects'),
  pollMs: Number(process.env.AHQ_POLL_MS || 3000),
  eventKeepDays: 7,
};
