import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {EventEmitter} from 'node:events';
import {openDb} from '../server/db.js';
import {createTasks} from '../server/tasks.js';
import {createProjectChat} from '../server/project-chat.js';
import {createApp} from '../server/app.js';
const settle=()=>new Promise(r=>setImmediate(r));
function setup(t,options={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hq-chat-')),db=openDb(':memory:'),calls=[];
 const spawn=()=>{const c=new EventEmitter();c.stdout=new EventEmitter();c.stderr=new EventEmitter();c.stdin=new EventEmitter();c.stdin.end=p=>c.prompt=p;c.kill=()=>{};calls.push(c);return c;};
 const tasks=createTasks({db,root,spawn,dataDir:root,timeoutMs:60000}),chat=createProjectChat({db,tasks,root,...options});
 const input={goal:'Build an accessible local calculator and test it.',project:'new',automatic:true,autoRepair:false,autoDeliver:false,requestId:crypto.randomUUID()};
 t.after(()=>{tasks.close();db.close();fs.rmSync(root,{recursive:true,force:true});});
 async function complete(text='Outcome\nStage done.\nChecks\nVerified.\nNext step\nNext specialist.\nCHECKS_PASSED: YES\nHANDOFF_READY: YES',code=0){await settle();const c=calls.at(-1);c.stdout.emit('data',JSON.stringify({type:'item.completed',item:{type:'agent_message',text}})+'\n');c.stdout.emit('data',JSON.stringify({type:'turn.completed'})+'\n');c.emit('close',code);await settle();}
 return {root,db,tasks,chat,calls,input,complete};
}
test('one owner request launches fixed project team, hands off honestly, and leaves final delivery for review',async t=>{
 const s=setup(t);let j=s.chat.create(s.input);assert.ok(fs.statSync(path.join(s.root,j.project)).isDirectory());
 for(let stage=0;stage<5;stage++){
  await s.complete();s.chat.tick();j=s.chat.get(j.id);
  if(stage<4){assert.equal(j.stage,stage+1);const previous=s.tasks.get(j.taskIds[stage]);assert.equal(previous.reviewSource,'project-policy');assert.match(previous.activity,/automatic project setting/);assert.doesNotMatch(previous.activity,/Approved by you/);}
  else{assert.equal(j.status,'needs-review');assert.equal(s.tasks.get(j.taskIds.at(-1)).status,'review');}
 }
 assert.equal(s.calls.length,5);assert.deepEqual(j.taskIds.map(id=>s.tasks.get(id).skill),['researcher','planner','builder','tester','writer']);assert.equal(new Set(j.taskIds.map(id=>s.tasks.get(id).project)).size,1);
 for(const c of s.calls)assert.match(c.prompt,/Never create accounts, accept terms/);
 s.tasks.review(j.taskIds.at(-1),'approved');s.chat.tick();assert.equal(s.chat.get(j.id).status,'completed');
});
test('blocked, missing-ready, failing checks, and failed runs cannot propagate; continuation is explicit',async t=>{
 for(const mode of ['no-ready','checks-fail','exit-fail']){
  const s=setup(t);let j=s.chat.create({...s.input,project:'new'});
  if(mode==='checks-fail'){for(let i=0;i<3;i++){await s.complete();s.chat.tick();}}
  await s.complete(mode==='checks-fail'?'CHECKS_PASSED: NO\nHANDOFF_READY: YES':'HANDOFF_READY: NO',mode==='exit-fail'?1:0);s.chat.tick();j=s.chat.get(j.id);assert.equal(j.status,'blocked');const count=j.taskIds.length;s.chat.tick();assert.equal(s.chat.get(j.id).taskIds.length,count);
  const resumed=s.chat.resume(j.id);assert.equal(resumed.stage,j.stage);assert.equal(resumed.taskIds.length,count+1);assert.equal(resumed.status,'active');s.chat.stop(j.id);assert.equal(s.chat.get(j.id).status,'stopped');
 }
});
test('new project requests are idempotent, path scoped, consent bound, and paused after restart',async t=>{
 const s=setup(t);const j=s.chat.create(s.input);assert.equal(s.chat.create(s.input).id,j.id);assert.equal(s.tasks.list().length,1);
 assert.throws(()=>s.chat.create({...s.input,goal:'Different request'}),/changed/);
 assert.throws(()=>s.chat.create({...s.input,requestId:crypto.randomUUID(),project:'../escape'}));
 assert.throws(()=>s.chat.create({...s.input,requestId:crypto.randomUUID(),automatic:false}));
 const restarted=createProjectChat({db:s.db,tasks:s.tasks,root:s.root});assert.equal(restarted.get(j.id).status,'paused');restarted.tick();assert.equal(s.tasks.list().length,1);assert.throws(()=>restarted.resume(j.id),/still active/);
});
test('chat API enforces origin, nonce and owner submission; summary module is served',async t=>{
 const s=setup(t),server=createApp({db:s.db,tasks:s.tasks,projectChat:s.chat,actions:{describe:()=>[],recentRuns:()=>[]},webDir:path.resolve('web')});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());const base=`http://127.0.0.1:${server.address().port}`;
 assert.equal((await fetch(base+'/task-summary.js')).status,200);assert.equal((await fetch(base+'/project-chat.js')).status,200);
 assert.equal((await fetch(base+'/api/project-chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...s.input,confirmed:true})})).status,403);
 const headers={'Content-Type':'application/json',Origin:base,'x-ahq-nonce':server.nonce};assert.equal((await fetch(base+'/api/project-chat',{method:'POST',headers,body:JSON.stringify(s.input)})).status,400);
 const r=await fetch(base+'/api/project-chat',{method:'POST',headers,body:JSON.stringify({...s.input,confirmed:true})});assert.equal(r.status,200);assert.equal((await r.json()).job.stage,0);
});
test('only timeouts continue automatically in the same stage, with checkpoints and a bounded retry count',async t=>{
 const s=setup(t);let j=s.chat.create(s.input);
 for(let i=0;i<3;i++){
  await s.complete('Partial work saved.',1);
  const task=s.tasks.get(j.taskIds.at(-1));s.db.raw.prepare('INSERT INTO hq_task_events(task_id,ts,kind,text) VALUES(?,?,?,?)').run(task.id,Date.now(),'timeout','Time budget reached');
  s.chat.tick();const next=s.chat.get(j.id);assert.equal(next.stage,0);
  if(i<2){assert.equal(next.status,'active');assert.equal(next.taskIds.length,j.taskIds.length+1);assert.equal(next.continuations[0],i+1);await settle();assert.match(s.calls.at(-1).prompt,/continuation after the time budget expired/);assert.equal(s.tasks.get(next.taskIds.at(-1)).skill,'researcher');}
  else{assert.equal(next.status,'blocked');assert.equal(next.taskIds.length,j.taskIds.length);}
  j=next;
 }
});
test('quota and permission failures do not retry or switch billing providers',async t=>{
 for(const text of ['Subscription quota reached. Cannot continue.','Permission denied: listen EPERM 127.0.0.1:5184','HUMAN_REQUIRED: YES\nHANDOFF_READY: NO']){const s=setup(t);const j=s.chat.create({...s.input,autoRepair:true});await s.complete(text,1);s.chat.tick();const next=s.chat.get(j.id);assert.equal(next.status,'blocked');assert.equal(next.taskIds.length,1);assert.equal(s.tasks.get(next.taskIds[0]).runtime,'codex');}
});
test('automatic repair preserves the failed stage and reruns its specialist before advancing',async t=>{
 const s=setup(t);let j=s.chat.create({...s.input,autoRepair:undefined});assert.equal(j.autoRepair,true);
 await s.complete('Outcome\nA local validation defect needs repair.\nHANDOFF_READY: NO');s.chat.tick();j=s.chat.get(j.id);
 assert.equal(j.status,'repairing');assert.equal(j.stage,0);assert.equal(j.repairs[0],1);assert.equal(j.taskIds.length,2);
 assert.equal(s.tasks.get(j.taskIds[0]).review,'changes-requested');assert.match(s.tasks.get(j.taskIds[0]).activity,/not an approved handoff/);assert.equal(s.tasks.get(j.taskIds[1]).skill,'builder');
 await s.complete('Outcome\nFixed the local validation defect.\nChecks\nActual repair check passed.\nHUMAN_REQUIRED: NO\nREPAIR_RESOLVED: YES\nHANDOFF_READY: YES');s.chat.tick();j=s.chat.get(j.id);
 assert.equal(j.status,'active');assert.equal(j.stage,0);assert.equal(j.taskIds.length,3);assert.equal(s.tasks.get(j.taskIds[2]).skill,'researcher');assert.equal(s.tasks.get(j.taskIds[1]).reviewSource,'project-policy');
 await settle();assert.match(s.calls.at(-1).prompt,/Independently verify this repair/);
 await s.complete();s.chat.tick();assert.equal(s.chat.get(j.id).stage,1);
});
test('automatic repairs are bounded, alternate specialists, and cannot claim verification by approval alone',async t=>{
 const s=setup(t);let j=s.chat.create({...s.input,autoRepair:true});
 for(let i=0;i<3;i++){await s.complete('Local defect remains.\nHANDOFF_READY: NO');s.chat.tick();j=s.chat.get(j.id);assert.equal(j.stage,0);if(i<2)assert.equal(j.status,'repairing');else assert.equal(j.status,'blocked');}
 assert.equal(j.taskIds.length,3);assert.equal(j.repairs[0],2);assert.deepEqual(j.taskIds.slice(1).map(id=>s.tasks.get(id).skill),['builder','tester']);
 s.chat.tick();assert.equal(s.chat.get(j.id).taskIds.length,3);
});
test('cancel and restart never replay a recovery automatically',async t=>{
 const s=setup(t);let j=s.chat.create({...s.input,autoRepair:true});await s.complete('HANDOFF_READY: NO');s.chat.tick();j=s.chat.get(j.id);
 const restarted=createProjectChat({db:s.db,tasks:s.tasks,root:s.root});assert.equal(restarted.get(j.id).status,'paused');restarted.tick();assert.equal(s.tasks.list().length,2);
 assert.throws(()=>restarted.resume(j.id),/still active/);restarted.stop(j.id);assert.equal(restarted.get(j.id).status,'stopped');
});
test('a failed run gets repair but an unverified repair cannot advance the project',async t=>{
 const s=setup(t);let j=s.chat.create({...s.input,autoRepair:true});await s.complete('Local test assertion failed.',1);s.chat.tick();j=s.chat.get(j.id);assert.equal(j.status,'repairing');
 await s.complete('I think it is fixed.\nHANDOFF_READY: YES');s.chat.tick();j=s.chat.get(j.id);assert.equal(j.stage,0);assert.equal(j.status,'repairing');assert.equal(j.repairs[0],2);
 assert.equal(s.tasks.get(j.taskIds[1]).review,'changes-requested');
});
test('new automatic projects deliver finished work without requiring owner approval',async t=>{
 const s=setup(t);let j=s.chat.create({...s.input,autoDeliver:true});
 for(let i=0;i<5;i++){await s.complete();s.chat.tick();}
 j=s.chat.get(j.id);assert.equal(j.status,'delivered');const final=s.tasks.get(j.taskIds.at(-1));assert.equal(final.status,'review');assert.equal(final.review,null);assert.equal(final.reviewOptional,true);assert.match(j.note,/finished/);assert.doesNotMatch(final.activity,/Approved by you/);
});
test('final delivery cannot conceal an unresolved owner blocker',async t=>{
 const s=setup(t);let j=s.chat.create({...s.input,autoDeliver:true});for(let i=0;i<4;i++){await s.complete();s.chat.tick();}
 await s.complete('HUMAN_REQUIRED: YES\nHANDOFF_READY: YES');s.chat.tick();assert.equal(s.chat.get(j.id).status,'blocked');
});
test('localhost listener failure gets one automatic static-preview continuation',async t=>{
 const s=setup(t,{preparePreview:async()=>({url:'http://127.0.0.1:43000/',kind:'static'})});let j=s.chat.create({...s.input,autoRepair:true});
 await s.complete('listen EPERM 127.0.0.1:4173\nHUMAN_REQUIRED: YES\nHANDOFF_READY: NO');s.chat.tick();assert.equal(s.chat.get(j.id).status,'preparing-preview');await settle();j=s.chat.get(j.id);assert.equal(j.status,'active');assert.equal(j.stage,0);assert.equal(j.taskIds.length,2);assert.equal(s.tasks.get(j.taskIds[0]).supersededBy,j.taskIds[1]);
 await s.complete('listen EPERM 127.0.0.1:4173\nHUMAN_REQUIRED: YES\nHANDOFF_READY: NO');s.chat.tick();assert.equal(s.chat.get(j.id).status,'blocked');assert.equal(s.chat.get(j.id).taskIds.length,2);
});
test('preview continuation cannot resume a project the owner stopped',async t=>{
 let release;const pending=new Promise(r=>release=r);const s=setup(t,{preparePreview:()=>pending});const j=s.chat.create({...s.input,autoRepair:true});await s.complete('listen EPERM localhost\nHANDOFF_READY: NO');s.chat.tick();s.chat.stop(j.id);release({url:'http://127.0.0.1:43000/',kind:'static'});await settle();assert.equal(s.chat.get(j.id).status,'stopped');assert.equal(s.chat.get(j.id).taskIds.length,1);
});
import {isReady,checksPassed,humanBlock,decision} from '../web/protocol.js';
test('protocol markers tolerate decoration and reason suffixes',()=>{assert.ok(isReady('done\n**HANDOFF_READY:** YES'));assert.ok(isReady('- HANDOFF_READY: YES — build passes'));assert.ok(checksPassed('CHECKS_PASSED: YES (12 checks)'));});
test('protocol markers ignore fenced, quoted, contradictory or absent decisions',()=>{assert.ok(!isReady('```\nHANDOFF_READY: YES\n```'));assert.ok(!isReady('> HANDOFF_READY: YES'));assert.ok(!isReady('HANDOFF_READY: YES\nHANDOFF_READY: NO'));assert.equal(decision('HANDOFF_READY: YES\nHANDOFF_READY: NO','HANDOFF_READY'),'CONFLICT');assert.ok(!isReady('all good'));assert.ok(!checksPassed('CHECKS_PASSED: NO'));});
test('explicit HUMAN_REQUIRED decision beats historical provider wording',()=>{assert.equal(humanBlock('An earlier probe hit permission denied; resolved.\nHUMAN_REQUIRED: NO'),false);assert.equal(humanBlock('HUMAN_REQUIRED: YES'),true);assert.equal(humanBlock('HUMAN_REQUIRED: YES\nHUMAN_REQUIRED: NO'),true);assert.equal(humanBlock('Hit the usage limit.'),true);assert.equal(humanBlock('```\nrate limit\n```\nok'),false);});
test('owner rejection after delivery blocks the project, clears optional-review and offers a follow-up',async t=>{
 const s=setup(t);let j=s.chat.create({...s.input,autoDeliver:true});for(let i=0;i<5;i++){await s.complete();s.chat.tick();}
 const finalId=s.chat.get(j.id).taskIds.at(-1);s.tasks.review(finalId,'changes-requested');s.chat.tick();j=s.chat.get(j.id);
 assert.equal(j.status,'blocked');assert.match(j.note,/requested changes/);const final=s.tasks.get(finalId);assert.equal(final.review,'changes-requested');assert.equal(final.reviewOptional,false);
 const before=s.calls.length;s.chat.resume(j.id);assert.equal(s.chat.get(j.id).status,'active');assert.equal(s.tasks.get(s.chat.get(j.id).taskIds.at(-1)).skill,'writer');assert.equal(s.calls.length,before);
});
test('owner approval after delivery completes the project and clears older review attempts in the same tick',async t=>{
 const s=setup(t);let j=s.chat.create({...s.input,autoDeliver:true});for(let i=0;i<5;i++){await s.complete();s.chat.tick();}
 const finalId=s.chat.get(j.id).taskIds.at(-1);s.tasks.review(finalId,'approved');s.chat.tick();assert.equal(s.chat.get(j.id).status,'completed');assert.equal(s.tasks.get(finalId).review,'approved');
});
test('a tester that reports ready but failed checks is superseded on explicit resume, never approved',async t=>{
 const s=setup(t);let j=s.chat.create(s.input);for(let i=0;i<3;i++){await s.complete();s.chat.tick();}
 await s.complete('Outcome\nChecks ran.\nCHECKS_PASSED: NO\nHANDOFF_READY: YES');s.chat.tick();
 // autoRepair is off, so the project blocks with the tester report left in review.
 j=s.chat.get(j.id);assert.equal(j.status,'blocked');const failed=j.taskIds.at(-1);assert.equal(s.tasks.get(failed).status,'review');
 s.chat.resume(j.id);const old=s.tasks.get(failed);assert.equal(old.review,'changes-requested');assert.ok(old.supersededBy);assert.equal(s.tasks.current(failed),old.supersededBy);
});
test('supersession chains resolve to the latest assignment without rewriting history',t=>{
 const s=setup(t);const mk=()=>s.tasks.create({title:'x',instructions:'y',project:'one',skill:'reviewer',runtime:'codex',mode:'read-only'});
 fs.mkdirSync(path.join(s.root,'one'),{recursive:true});const a=mk(),b=mk(),c=mk();
 for(const id of [a.id,b.id]){const row=s.tasks.get(id);row.status='review';s.db.raw.prepare('UPDATE hq_tasks SET record=? WHERE id=?').run(JSON.stringify(row),id);}
 s.tasks.supersede(a.id,b.id);s.tasks.supersede(b.id,c.id);assert.equal(s.tasks.get(a.id).supersededBy,b.id);assert.equal(s.tasks.current(a.id),c.id);assert.equal(s.tasks.detail(a.id).currentId,c.id);
});
const BROWSERLESS='Outcome\nCode checks passed.\nBrowser checks were blocked: computer-use reported no browser; Playwright failed with EPERM.\nCHECKS_PASSED: NO\nHUMAN_REQUIRED: YES\nHANDOFF_READY: NO';
const fakeEvidence=(calls=[])=>({run:async(preview,{id})=>{calls.push({preview,id});return {at:1,url:preview.url,files:['desktop-1440.png'],checks:[{name:'Page loads',state:'pass',detail:'ok'},{name:'No horizontal overflow at 320px',state:'fail',detail:'12px too wide'}],summary:'HQ BROWSER EVIDENCE (real headless Chrome)\nPASS Page loads: ok\nFAIL No horizontal overflow at 320px: 12px too wide'};},evidencePath:()=>null});
async function toTester(s,j){for(let i=0;i<3;i++){await s.complete();s.chat.tick();}return s.chat.get(j.id);}
test('a tester with no browser triggers HQ browser evidence once, then reruns the tester with it',async t=>{
 const calls=[];const s=setup(t,{preparePreview:async()=>({url:'http://127.0.0.1:43000/',kind:'static'}),browserEvidence:fakeEvidence(calls)});let j=s.chat.create({...s.input,autoRepair:true});j=await toTester(s,j);assert.equal(j.stage,3);
 await s.complete(BROWSERLESS);s.chat.tick();assert.equal(s.chat.get(j.id).status,'collecting-evidence');await settle();await settle();j=s.chat.get(j.id);
 assert.equal(j.status,'active');assert.equal(j.stage,3);assert.equal(calls.length,1);assert.equal(j.evidence.checks.length,2);assert.equal(s.tasks.get(j.taskIds.at(-2)).supersededBy,j.taskIds.at(-1));assert.notEqual(s.tasks.get(j.taskIds.at(-2)).review,'approved');
 assert.match(s.calls.at(-1).prompt,/HQ BROWSER EVIDENCE/);assert.match(s.calls.at(-1).prompt,/FAIL No horizontal overflow/);
 // Evidence is bounded to one per stage: a second browserless report must fall through to the normal repair/block path.
 await s.complete(BROWSERLESS);s.chat.tick();assert.notEqual(s.chat.get(j.id).status,'collecting-evidence');assert.equal(calls.length,1);
});
test('browser evidence is not used for provider or login blocks, and falls back when no Chrome exists',async t=>{
 const calls=[];const s=setup(t,{preparePreview:async()=>({url:'http://127.0.0.1:43000/',kind:'static'}),browserEvidence:fakeEvidence(calls)});let j=s.chat.create({...s.input,autoRepair:true});j=await toTester(s,j);
 await s.complete('Browser unavailable: no browser. Usage limit reached.\nHUMAN_REQUIRED: YES\nHANDOFF_READY: NO');s.chat.tick();assert.notEqual(s.chat.get(j.id).status,'collecting-evidence');assert.equal(calls.length,0);
 const s2=setup(t,{preparePreview:async()=>({url:'http://127.0.0.1:43000/',kind:'static'}),browserEvidence:{run:async()=>null,evidencePath:()=>null}});let k=s2.chat.create({...s2.input,autoRepair:true});k=await toTester(s2,k);
 await s2.complete(BROWSERLESS);s2.chat.tick();await settle();await settle();assert.notEqual(s2.chat.get(k.id).status,'collecting-evidence');assert.notEqual(s2.chat.get(k.id).status,'active');assert.equal(s2.chat.get(k.id).evidence,undefined);
});
test('stopping the project while evidence is collected prevents the tester rerun',async t=>{
 let release;const s=setup(t,{preparePreview:async()=>({url:'http://127.0.0.1:43000/',kind:'static'}),browserEvidence:{run:()=>new Promise(r=>release=r),evidencePath:()=>null}});let j=s.chat.create({...s.input,autoRepair:true});j=await toTester(s,j);
 await s.complete(BROWSERLESS);s.chat.tick();await settle();s.chat.stop(j.id);const before=s.calls.length;release({at:1,url:'x',files:[],checks:[],summary:'s'});await settle();await settle();assert.equal(s.chat.get(j.id).status,'stopped');assert.equal(s.calls.length,before);
});
