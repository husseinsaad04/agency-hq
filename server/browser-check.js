// HQ-side browser acceptance evidence. HQ itself drives a headless Chrome against its own
// loopback static preview: fixed argv, fixed probe scripts, a throwaway profile, no shell and no
// project code beyond the page the preview serves. Worker sandboxes and permissions are untouched.
// The result is evidence for the original specialist to judge; HQ never declares a project verified.
import {spawn as nodeSpawn} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {CONFIG} from './config.js';

const CHROME_CANDIDATES = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'];
export const PREVIEW_URL = /^http:\/\/127\.0\.0\.1:\d+\/$/;
export const VIEWPORTS = [{name: 'mobile', width: 320, height: 700}, {name: 'tablet', width: 768, height: 1024}, {name: 'desktop', width: 1440, height: 900}];

const PAGE_PROBE = `(()=>{const q=s=>document.querySelectorAll(s);const vis=e=>!!(e.offsetWidth||e.offsetHeight||e.getClientRects().length);
return JSON.stringify({title:document.title,h1:(q('h1')[0]||{}).textContent||'',lang:document.documentElement.lang||'',viewportMeta:!!document.querySelector('meta[name=viewport]'),
landmarks:['header','main','nav','footer'].filter(t=>q(t).length).length,hasMain:q('main,[role=main]').length>0,
overflow:document.documentElement.scrollWidth-innerWidth,imagesNoAlt:[...document.images].filter(i=>!i.hasAttribute('alt')).length,
brokenImages:[...document.images].filter(i=>i.complete&&i.naturalWidth===0).length,interactive:[...q('a[href],button,input,select,textarea,[tabindex]')].filter(vis).length,textLength:(document.body.innerText||'').trim().length});})()`;
const INTERACT_PROBE = `(async()=>{const href=location.href;const btns=[...document.querySelectorAll('button:not([type=submit]),[role=tab],[aria-pressed]')].filter(b=>b.offsetParent&&!b.closest('form')&&!b.disabled&&(b.textContent||'').trim().length<30).slice(0,8);
let flag=false;const mo=new MutationObserver(()=>{flag=true;});mo.observe(document.body,{subtree:true,childList:true,attributes:true,characterData:true});let changed=0;
for(const b of btns){flag=false;b.click();await new Promise(r=>setTimeout(r,120));if(flag)changed++;}mo.disconnect();return JSON.stringify({tried:btns.length,changed,navigated:location.href!==href});})()`;
const FOCUS_PROBE = `(()=>{const e=document.activeElement;if(!e||e===document.body)return '';const cs=getComputedStyle(e);return e.tagName+':'+(cs.outlineStyle!=='none'&&parseFloat(cs.outlineWidth)>0||cs.boxShadow!=='none'?'ring':'noring');})()`;

// Pure: turn raw probe results into pass/fail/gap checks. 'gap' is never a blocker.
export function evaluateChecks({pages, interact, focus, noscript, consoleErrors}) {
  const checks = [], add = (name, state, detail) => checks.push({name, state, detail});
  const d = pages.find(p => p.name === 'desktop') || pages[0];
  add('Page loads with a title and heading', d.probe.title && d.probe.h1.trim() ? 'pass' : 'fail', d.probe.title ? `“${d.probe.title.slice(0, 60)}”` : 'missing <title>');
  add('No console errors or exceptions', consoleErrors.length ? 'fail' : 'pass', consoleErrors.length ? consoleErrors.slice(0, 2).join(' | ').slice(0, 160) : 'none');
  for (const p of pages) add(`No horizontal overflow at ${p.width}px`, p.probe.overflow <= 1 ? 'pass' : 'fail', p.probe.overflow <= 1 ? 'fits' : `${p.probe.overflow}px too wide`);
  add('Images have alt text and load', d.probe.imagesNoAlt === 0 && d.probe.brokenImages === 0 ? 'pass' : 'fail', `${d.probe.imagesNoAlt} without alt, ${d.probe.brokenImages} broken`);
  add('Main landmark present', d.probe.hasMain ? 'pass' : 'gap', d.probe.hasMain ? `${d.probe.landmarks} landmarks` : 'no <main>');
  add('Language and responsive viewport declared', d.probe.lang && d.probe.viewportMeta ? 'pass' : 'gap', `lang=${d.probe.lang || 'none'}, viewport meta ${d.probe.viewportMeta ? 'yes' : 'no'}`);
  add('Keyboard Tab reaches controls', d.probe.interactive === 0 ? 'gap' : focus.length ? 'pass' : 'fail', d.probe.interactive === 0 ? 'no interactive controls' : `${focus.length} stops${focus.some(f => f.endsWith('noring')) ? '; some without a visible focus style' : ''}`);
  add('Clicking controls changes the page', !interact.tried ? 'gap' : interact.navigated ? 'gap' : interact.changed ? 'pass' : 'fail', !interact.tried ? 'no button controls to try' : `${interact.changed}/${interact.tried} controls changed the DOM`);
  add('Readable without scripts', noscript == null ? 'gap' : noscript > 200 ? 'pass' : 'gap', noscript == null ? 'script-free fixture unavailable' : `${noscript} characters rendered`);
  return checks;
}
export function summarize(result) {
  const icon = {pass: 'PASS', fail: 'FAIL', gap: 'GAP'};
  const lines = result.checks.map(c => `${icon[c.state]} ${c.name}: ${c.detail}`);
  return `HQ BROWSER EVIDENCE (real headless Chrome run by HQ against ${result.url}; ${result.checks.filter(c => c.state === 'fail').length} failing, ${result.checks.filter(c => c.state === 'gap').length} gaps).\n${lines.join('\n')}\nNot covered: site-specific flows (forms, filters beyond generic button clicks), screen readers, toolbar zoom.`;
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl), pending = new Map(), listeners = [];
  let id = 0;
  const ready = new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('devtools connection failed')); });
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } else listeners.forEach(l => l(m));
  };
  return {ready, on: f => listeners.push(f), close: () => { try { ws.close(); } catch {} },
    send: (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++id; pending.set(i, {res, rej}); ws.send(JSON.stringify({id: i, method, params, sessionId})); })};
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

export function createBrowserChecker({dataDir = CONFIG.dataDir, chrome = process.env.AHQ_CHROME, spawn = nodeSpawn, timeoutMs = 90_000} = {}) {
  let found;
  async function chromePath() {
    if (found !== undefined) return found;
    for (const c of chrome ? [chrome] : CHROME_CANDIDATES) try { await fs.access(c); return (found = c); } catch {}
    return (found = null);
  }
  async function execute(bin, url, scriptFreeUrl, outDir) {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-chrome-'));
    const child = spawn(bin, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--disable-sync', '--mute-audio', 'about:blank'], {stdio: 'ignore'});
    let client;
    try {
      let endpoint;
      for (let i = 0; i < 60 && !endpoint; i++) {
        try { const [port, p] = (await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n'); endpoint = `ws://127.0.0.1:${port}${p}`; } catch { await sleep(250); }
      }
      if (!endpoint) throw new Error('Chrome did not start');
      client = cdp(endpoint); await client.ready;
      const {targetId} = await client.send('Target.createTarget', {url: 'about:blank'});
      const {sessionId} = await client.send('Target.attachToTarget', {targetId, flatten: true});
      const send = (m, p) => client.send(m, p, sessionId);
      const consoleErrors = [];
      client.on(m => {
        if (m.sessionId !== sessionId) return;
        if (m.method === 'Runtime.exceptionThrown') consoleErrors.push(String(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text).split('\n')[0]);
        if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') consoleErrors.push((m.params.args || []).map(a => a.value ?? a.description ?? '').join(' '));
        if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error' && !/\/favicon\.ico(?:$|\?)/.test(m.params.entry.url || '')) consoleErrors.push(`${m.params.entry.text} ${m.params.entry.url || ''}`.trim());
      });
      await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
      const evalJson = async expr => JSON.parse((await send('Runtime.evaluate', {expression: expr, returnByValue: true, awaitPromise: true})).result.value);
      const load = async u => { await send('Page.navigate', {url: u}); await sleep(900); };
      await fs.mkdir(outDir, {recursive: true});
      const pages = [], files = [];
      for (const v of VIEWPORTS) {
        await send('Emulation.setDeviceMetricsOverride', {width: v.width, height: v.height, deviceScaleFactor: 1, mobile: v.width < 768});
        await load(url);
        const probe = await evalJson(PAGE_PROBE);
        const shot = await send('Page.captureScreenshot', {format: 'png', captureBeyondViewport: true});
        const name = `${v.name}-${v.width}.png`; await fs.writeFile(path.join(outDir, name), Buffer.from(shot.data, 'base64')); files.push(name);
        pages.push({...v, probe});
      }
      await send('Emulation.setDeviceMetricsOverride', {width: 1440, height: 900, deviceScaleFactor: 1, mobile: false});
      await load(url);
      const focus = [];
      for (let i = 0; i < 12; i++) {
        await send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9});
        await send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9});
        const f = (await send('Runtime.evaluate', {expression: FOCUS_PROBE, returnByValue: true})).result.value; if (f) focus.push(f);
      }
      const interact = await evalJson(INTERACT_PROBE);
      let noscript = null;
      if (scriptFreeUrl && PREVIEW_URL.test(scriptFreeUrl.replace(/__hq-noscript\/$/, ''))) { await load(scriptFreeUrl); noscript = (await evalJson(PAGE_PROBE)).textLength; }
      return {pages, focus, interact, noscript, consoleErrors: [...new Set(consoleErrors)], files};
    } finally {
      client?.close(); try { child.kill('SIGKILL'); } catch {}
      await fs.rm(profile, {recursive: true, force: true}).catch(() => {});
    }
  }
  return {
    available: async () => Boolean(await chromePath()),
    // preview = {url, scriptFreeUrl} from the static preview service. Returns null when no Chrome is installed.
    async run(preview, {id}) {
      if (!preview || !PREVIEW_URL.test(preview.url)) throw new Error('Browser evidence runs only against an HQ loopback static preview.');
      if (!/^[-a-f0-9]{8,64}$/.test(id)) throw new Error('invalid evidence id');
      const bin = await chromePath(); if (!bin) return null;
      let timer;
      const raw = await Promise.race([execute(bin, preview.url, preview.scriptFreeUrl, path.join(dataDir, 'evidence', id)), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('Browser evidence timed out')), timeoutMs); })]).finally(() => clearTimeout(timer));
      const result = {at: Date.now(), url: preview.url, files: raw.files, checks: evaluateChecks(raw)};
      result.summary = summarize(result);
      return result;
    },
    evidencePath: (id, file) => /^[-a-f0-9]{8,64}$/.test(id) && /^[a-z]+-\d+\.png$/.test(file) ? path.join(dataDir, 'evidence', id, file) : null,
  };
}
