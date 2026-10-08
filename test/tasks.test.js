import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { openDb } from '../server/db.js';
import { createTasks, eventSummary, redact } from '../server/tasks.js';
import { createApp } from '../server/app.js';
import { resolveProject } from '../server/actions.js';
const settle = () => new Promise(resolve => setImmediate(resolve));
function setup(t,options={}) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hq-tasks-'));const root=path.join(dir,'projects');fs.mkdirSync(root);for(const p of ['one','two'])fs.mkdirSync(path.join(root,p));
 const db=openDb(':memory:');const calls=[];
 const spawn=(file,args,options)=>{const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();child.stdin.end=x=>child.input=x;child.signals=[];child.kill=s=>child.signals.push(s);calls.push({file,args,options,child});return child;};
 const runner=createTasks({db,spawn,root,dataDir:dir,home:'/home/test',timeoutMs:30000,...options});
 t.after(()=>{runner.close();db.close();fs.rmSync(dir,{recursive:true,force:true});});
 const input={title:'Inspect project',instructions:'Inspect README and report findings',project:'one',skill:'reviewer',runtime:'codex',mode:'read-only'};
 return {dir,root,db,calls,runner,input};
}
test('task dispatch passes fixed CLI arguments and instructions over stdin',async t=>{
 const s=setup(t);const task=s.runner.create({...s.input,instructions:'Inspect `x`; $(touch nope)'});await settle();
 const call=s.calls[0];assert.equal(call.file,'/opt/homebrew/bin/codex');assert.ok(call.args.includes('--sandbox'));assert.ok(call.args.includes('read-only'));assert.equal(call.options.cwd,path.join(s.root,'one'));assert.ok(!call.args.some(x=>x.includes('touch nope')));assert.match(call.child.input,/touch nope/);assert.equal(s.runner.get(task.id).status,'running');assert.equal(s.runner.get(task.id).billingMode,'chatgpt-subscription');assert.ok(call.args.includes('forced_login_method="chatgpt"'));assert.ok(s.runner.detail(task.id).events.some(e=>e.kind==='tools'));
 assert.ok(!s.db.actionLog()[0].params.includes('touch nope'));
});
test('queue allows different projects concurrently but serializes the same project',async t=>{
 const s=setup(t);s.runner.create(s.input);const waiting=s.runner.create(s.input);s.runner.create({...s.input,project:'two'});await settle();assert.equal(s.calls.length,2);assert.equal(s.runner.get(waiting.id).status,'queued');
 s.calls[0].child.stdout.emit('data',JSON.stringify({type:'turn.completed'})+'\n');s.calls[0].child.emit('close',0);await settle();assert.equal(s.calls.length,3);assert.equal(s.runner.get(waiting.id).status,'running');
});
test('split JSON chunks produce actual tools and replies, then await human review',async t=>{
 const s=setup(t);const task=s.runner.create(s.input);await settle();const c=s.calls[0].child;
 const line=JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Findings: README is present.'}})+'\n';c.stdout.emit('data',line.slice(0,15));c.stdout.emit('data',line.slice(15));c.stdout.emit('data',JSON.stringify({type:'item.started',item:{type:'command_execution',command:'cat README.md'}})+'\n');c.stdout.emit('data',JSON.stringify({type:'turn.completed'})+'\n');c.emit('close',0);
 const detail=s.runner.detail(task.id);assert.equal(detail.status,'review');assert.match(detail.result,/README is present/);assert.ok(detail.events.some(e=>e.text==='Running command: cat README.md'));assert.equal(s.runner.review(task.id,'approved').status,'completed');assert.throws(()=>s.runner.review(task.id,'approved'));
});
test('provider errors cannot be mislabeled success even with zero exit code',async t=>{
 const s=setup(t);const task=s.runner.create({...s.input,runtime:'claude'});await settle();const c=s.calls[0].child;c.stdout.emit('data',JSON.stringify({type:'result',is_error:true,result:'Usage limit reached'})+'\n');c.emit('close',0);assert.equal(s.runner.get(task.id).status,'failed');assert.match(s.runner.get(task.id).result,/Usage limit/);
});
test('permission denials produce failed tasks and inspection CLI uses allowlisted tools',async t=>{
 const s=setup(t);const task=s.runner.create({...s.input,runtime:'claude'});await settle();const call=s.calls[0];assert.ok(!call.args.includes('--dangerously-skip-permissions'));assert.ok(call.args.includes('dontAsk'));assert.ok(call.args.includes('Read,Glob,Grep,WebSearch,WebFetch'));
 call.child.stdout.emit('data',JSON.stringify({type:'result',is_error:false,result:'Could not inspect',permission_denials:[{tool_name:'Read'}]})+'\n');call.child.emit('close',0);assert.equal(s.runner.get(task.id).status,'failed');
});
test('cancel waits for process close before releasing the project lock',async t=>{
 const s=setup(t);const first=s.runner.create(s.input),second=s.runner.create(s.input);await settle();const c=s.calls[0].child;s.runner.cancel(first.id);assert.deepEqual(c.signals,['SIGTERM']);assert.equal(s.runner.get(first.id).status,'cancelling');assert.equal(s.runner.get(second.id).status,'queued');c.emit('close',null);await settle();assert.equal(s.runner.get(first.id).status,'cancelled');assert.equal(s.runner.get(second.id).status,'running');
});
test('queued cancellation never starts the agent',async t=>{const s=setup(t);s.runner.create(s.input);await settle();const task=s.runner.create(s.input);s.runner.cancel(task.id);await settle();assert.equal(s.calls.length,1);assert.equal(s.runner.get(task.id).status,'cancelled');});
test('restart marks pending work interrupted without automatically relaunching',async t=>{
 const s=setup(t);const task=s.runner.create(s.input);await settle();s.runner.close();const recovered=createTasks({db:s.db,spawn:()=>assert.fail('must not restart'),root:s.root});assert.equal(recovered.get(task.id).status,'interrupted');assert.ok(recovered.detail(task.id).events.some(e=>e.kind==='interrupted'));recovered.close();
});
test('validation rejects unknown runtimes, unsafe projects, and unsupported write modes',t=>{
 const s=setup(t);for(const patch of [{runtime:'bash'},{project:'../other'},{skill:'anything'},{mode:'danger-full-access'},{runtime:'ruflo',mode:'workspace-write'},{title:''}])assert.throws(()=>s.runner.create({...s.input,...patch}));
 const outside=path.join(s.dir,'outside');fs.mkdirSync(outside);fs.symlinkSync(outside,path.join(s.root,'escape'));assert.throws(()=>resolveProject('escape',s.root),/outside/);
});
test('reusable skills persist and are applied to dispatched tasks',async t=>{
 const s=setup(t);const skill=s.runner.addSkill({name:'Client strategist',prompt:'Compare client acquisition channels with evidence.'});assert.ok(s.runner.skills().some(x=>x.id===skill.id));s.runner.create({...s.input,skill:skill.id});await settle();assert.match(s.calls[0].child.input,/Compare client acquisition channels/);assert.throws(()=>s.runner.addSkill({name:'',prompt:'x'}));
});
test('observability omits private reasoning and redacts common secrets',()=>{
 assert.equal(eventSummary({type:'item.completed',item:{type:'reasoning',text:'private'}}),null);assert.equal(eventSummary({type:'assistant',message:{content:[{type:'thinking',thinking:'private'}]}}),null);assert.equal(redact('api_key=secret-value password=foo sk-abcdefghijklmno'),'api_key=[redacted] password=[redacted] [redacted]');
});
test('task API requires browser origin, nonce and confirmation; list hides instructions',async t=>{
 const s=setup(t);const actions={describe:()=>[],recentRuns:()=>[]};const server=createApp({db:s.db,actions,tasks:s.runner,webDir:path.resolve('web')});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());const base=`http://127.0.0.1:${server.address().port}`;
 const request=(body,headers={})=>fetch(base+'/api/tasks',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
 assert.equal((await request(s.input)).status,403);const headers={Origin:base,'x-ahq-nonce':server.nonce};assert.equal((await request(s.input,headers)).status,400);const response=await request({...s.input,confirmed:true},headers);assert.equal(response.status,201);
 const {task}=await response.json();const listing=await (await fetch(base+'/api/tasks')).json();assert.equal(listing.tasks[0].instructions,undefined);assert.equal(listing.tasks[0].result,undefined);assert.equal((await fetch(base+`/api/tasks/${task.id}`)).status,200);
 assert.equal((await fetch(base+'/missions.js')).status,200);assert.equal((await fetch(base+'/protocol.js')).status,200);
});
test('time budget fails the task after stopping it, and provider usage is retained',async t=>{
 const s=setup(t);s.runner.close();const runner=createTasks({db:s.db,spawn:(...args)=>{const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();child.stdin.end=()=>{};child.kill=()=>setImmediate(()=>child.emit('close',null));s.calls.push({child});return child;},root:s.root,timeoutMs:20});t.after(()=>runner.close());
 const task=runner.create(s.input);await settle();s.calls[0].child.stdout.emit('data',JSON.stringify({type:'turn.completed',usage:{input_tokens:42,output_tokens:9}})+'\n');await new Promise(r=>setTimeout(r,40));assert.equal(runner.get(task.id).status,'failed');assert.match(runner.get(task.id).activity,/Time budget/);assert.equal(runner.get(task.id).usage.inputTokens,42);
});
test('Ruflo initializes isolated coordination before launching its restricted Claude child',async t=>{
 const s=setup(t);const task=s.runner.create({...s.input,runtime:'ruflo'});await settle();const first=s.calls[0];assert.deepEqual(first.args,['hive-mind','init','--max-agents','3']);assert.ok(first.options.cwd.includes(task.id));
 const wrapper=fs.readFileSync(path.join(first.options.cwd,'bin','claude'),'utf8');assert.match(wrapper,/--restricted --strict-mcp-config/);assert.match(wrapper,/--permission-mode dontAsk/);first.child.emit('close',0);assert.equal(s.calls.length,2);assert.ok(s.calls[1].args.includes('--no-auto-permissions'));assert.ok(s.calls[1].args.includes('--claude'));
});
test('prepared preview reaches the worker without changing its sandbox',async t=>{const preview={url:'http://127.0.0.1:43000/',kind:'static'};const s=setup(t,{preparePreview:async()=>preview});const task=s.runner.create(s.input);await settle();await settle();assert.equal(s.calls.length,1);assert.deepEqual(s.runner.get(task.id).preview,preview);assert.match(s.calls[0].child.input,/HQ static preview: http:\/\/127\.0\.0\.1:43000/);assert.ok(s.calls[0].args.includes('read-only'));assert.ok(!s.calls[0].args.includes('danger-full-access'));});
test('cancelling during preview setup never starts a worker',async t=>{let release;const s=setup(t,{preparePreview:()=>new Promise(r=>release=r)});const task=s.runner.create(s.input);await settle();s.runner.cancel(task.id);release(null);await settle();assert.equal(s.calls.length,0);assert.equal(s.runner.get(task.id).status,'cancelled');});
test('preview setup that never settles falls back after its bound and still starts the worker',async t=>{const s=setup(t,{preparePreview:()=>new Promise(()=>{}),previewTimeoutMs:20});const task=s.runner.create(s.input);await new Promise(r=>setTimeout(r,80));await settle();assert.equal(s.calls.length,1);assert.equal(s.runner.get(task.id).status,'running');assert.equal(s.runner.get(task.id).preview,undefined);});
test('cancelling a never-settling preview setup frees the slot and the project',async t=>{const s=setup(t,{preparePreview:()=>new Promise(()=>{}),previewTimeoutMs:60000});const a=s.runner.create(s.input);await settle();s.runner.cancel(a.id);assert.equal(s.runner.get(a.id).status,'cancelled');const b=s.runner.create(s.input);await settle();await settle();assert.equal(s.runner.get(b.id).status,'running');});
test('page and state stream share a per-process boot id that is not the nonce',async t=>{const s=setup(t);const app=createApp({db:s.db,tasks:s.runner,actions:{describe:()=>[],recentRuns:()=>[]},webDir:path.resolve('web'),pollMs:20});await new Promise(r=>app.listen(0,'127.0.0.1',r));t.after(()=>{app.closeAllConnections?.();app.close();});const base=`http://127.0.0.1:${app.address().port}`;const html=await(await fetch(base+'/')).text();const boot=/name="ahq-boot" content="([0-9a-f]+)"/.exec(html)?.[1];assert.ok(boot);assert.notEqual(boot,app.nonce);const ctl=new AbortController();const res=await fetch(base+'/api/stream',{signal:ctl.signal});const reader=res.body.getReader();const chunk=new TextDecoder().decode((await reader.read()).value);await reader.cancel();ctl.abort();assert.ok(chunk.includes(`"boot":"${boot}"`));});
test('preview reopen route is nonce guarded, confirmed, project scoped and runs no commands',async t=>{
 const s=setup(t);fs.writeFileSync(path.join(s.root,'one','index.html'),'<h1>Hi</h1>');
 const {createStaticPreviews}=await import('../server/static-preview.js');const previews=createStaticPreviews({root:s.root,db:s.db});t.after(()=>previews.close());
 const app=createApp({db:s.db,tasks:s.runner,previews,actions:{describe:()=>[],recentRuns:()=>[]},webDir:path.resolve('web')});await new Promise(r=>app.listen(0,'127.0.0.1',r));t.after(()=>{app.closeAllConnections?.();app.close();});
 const base=`http://127.0.0.1:${app.address().port}`,task=s.runner.create(s.input);
 const post=(headers,body)=>fetch(`${base}/api/tasks/${task.id}/preview`,{method:'POST',headers:{'Content-Type':'application/json',origin:base,...headers},body:JSON.stringify(body)});
 assert.equal((await post({},{confirmed:true})).status,403);
 assert.equal((await post({'x-ahq-nonce':app.nonce},{})).status,400);
 const ok=await post({'x-ahq-nonce':app.nonce},{confirmed:true});assert.equal(ok.status,200);const d=await ok.json();assert.match(d.preview.url,/^http:\/\/127\.0\.0\.1:\d+\/$/);assert.match(await(await fetch(d.preview.url)).text(),/Hi/);
});
