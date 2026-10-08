import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {createBrowserChecker,evaluateChecks,summarize} from '../server/browser-check.js';
import {createStaticPreviews} from '../server/static-preview.js';
const probe=o=>({title:'T',h1:'H',lang:'en',viewportMeta:true,landmarks:4,hasMain:true,overflow:0,imagesNoAlt:0,brokenImages:0,interactive:3,textLength:500,...o});
const pages=o=>[320,768,1440].map(width=>({name:width===1440?'desktop':String(width),width,probe:probe(width===320?o:{})}));
test('evidence checks pass a healthy page and fail overflow, console errors and missing alt',()=>{
 const ok=evaluateChecks({pages:pages({}),interact:{tried:2,changed:2},focus:['A:ring'],noscript:600,consoleErrors:[]});assert.ok(ok.every(c=>c.state==='pass'));
 const bad=evaluateChecks({pages:pages({overflow:40}),interact:{tried:2,changed:0},focus:[],noscript:10,consoleErrors:['TypeError: x']});
 const by=n=>bad.find(c=>c.name.startsWith(n)).state;assert.equal(by('No horizontal overflow at 320'),'fail');assert.equal(by('No console'),'fail');assert.equal(by('Keyboard'),'fail');assert.equal(by('Clicking'),'fail');assert.equal(by('Readable without'),'gap');
 assert.match(summarize({url:'http://127.0.0.1:1/',checks:bad}),/FAIL No horizontal overflow at 320px/);
});
test('evidence runs only against loopback HQ previews and exposes only named screenshots',async()=>{
 const c=createBrowserChecker({dataDir:'/tmp/hq-ev-x',chrome:'/nonexistent/chrome'});
 for(const url of ['https://example.com/','http://localhost:3000/','http://127.0.0.1:80/evil','file:///etc/passwd'])await assert.rejects(c.run({url},{id:'aaaaaaaa-1'}),/loopback/);
 assert.equal(await c.run({url:'http://127.0.0.1:5000/'},{id:'aaaaaaaa-1'}),null);
 assert.equal(c.evidencePath('aaaaaaaa-1','../../etc/passwd'),null);assert.equal(c.evidencePath('../x','desktop-1440.png'),null);assert.match(c.evidencePath('aaaaaaaa-1','desktop-1440.png'),/evidence\/aaaaaaaa-1\/desktop-1440\.png$/);
});
const real=await createBrowserChecker().available();
test('real headless Chrome produces evidence and screenshots for a static preview',{skip:!real},async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'hq-bc-')),site=path.join(root,'site'),data=await fs.mkdtemp(path.join(os.tmpdir(),'hq-bcd-'));await fs.mkdir(site);
 await fs.writeFile(path.join(site,'index.html'),'<!doctype html><html lang="en"><head><title>Hi</title><meta name="viewport" content="width=device-width"></head><body><main><h1>Hello</h1><button id=b>Toggle</button><p id=p>'+'text '.repeat(80)+'</p></main><script>document.getElementById("b").onclick=()=>{document.getElementById("p").hidden=!document.getElementById("p").hidden}</script></body></html>');
 const previews=createStaticPreviews({root});t.after(()=>{previews.close();return Promise.all([fs.rm(root,{recursive:true,force:true}),fs.rm(data,{recursive:true,force:true})]);});
 const result=await createBrowserChecker({dataDir:data}).run(await previews.ensure('site'),{id:'bbbbbbbb-2'});
 assert.ok(result.checks.every(c=>c.state!=='fail'),result.summary);assert.equal(result.files.length,3);assert.ok((await fs.stat(path.join(data,'evidence','bbbbbbbb-2','mobile-320.png'))).size>500);
 assert.equal(result.checks.find(c=>c.name.startsWith('Clicking')).state,'pass');
});
