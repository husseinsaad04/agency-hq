#!/usr/bin/env node
// Claude Code hook -> Agency HQ. Runs async on every event; must NEVER block, print, or fail loudly.
// It reduces the raw event to a tiny privacy-safe payload (see server/sanitize.js) and POSTs it to localhost.
// Always exits 0 (exit code 2 would block Claude Code), even if Agency HQ is not running.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { sanitizeHook } from '../server/sanitize.js';

const quit = () => process.exit(0);
setTimeout(quit, 1500).unref(); // hard stop no matter what

try {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 2_000_000) break;
  }
  const payload = sanitizeHook(JSON.parse(input));
  if (!payload) quit();
  const token = fs.readFileSync(path.join(process.env.AHQ_DATA || path.join(os.homedir(), '.agency-hq'), 'hook-token'), 'utf8').trim();
  const body = JSON.stringify(payload);
  const req = http.request(
    { host: '127.0.0.1', port: Number(process.env.AHQ_PORT || 7777), path: '/api/hook', method: 'POST', timeout: 800, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: `Bearer ${token}` } },
    (res) => { res.resume(); res.on('end', quit); }
  );
  req.on('error', quit);
  req.on('timeout', () => { req.destroy(); quit(); });
  req.end(body);
} catch {
  quit();
}
