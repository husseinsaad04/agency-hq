import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { openDb } from '../server/db.js';
import { createTasks } from '../server/tasks.js';
import { createCompany } from '../server/company.js';
import { createApp } from '../server/app.js';
import { COMPANY_SKILLS,WORKFLOWS,routeGoal } from '../server/company-catalog.js';
const settle=()=>new Promise(r=>setImmediate(r));
function setup(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hq-company-'));const root=path.join(dir,'projects');fs.mkdirSync(root);for(const p of ['one','two'])fs.mkdirSync(path.join(root,p));const db=openDb(':memory:');const calls=[];
 const spawn=(file,args,options)=>{const c=new EventEmitter();c.stdout=new EventEmitter();c.stderr=new EventEmitter();c.stdin=new EventEmitter();c.stdin.end=x=>c.input=x;c.kill=()=>{};calls.push(c);return c;};
 const tasks=createTasks({db,spawn,root,dataDir:dir,home:'/home/test',timeoutMs:30000});const company=createCompany({db,tasks});
 t.after(()=>{tasks.close();db.close();fs.rmSync(dir,{recursive:true,force:true});});
 const input={workflow:'company-health',goal:'Review project health and documentation',project:'one',runtime:'codex',mode:'read-only',budgetMinutes:5};
 const complete=async()=>{const c=calls.at(-1);c.stdout.emit('data',JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Verified project findings.'}})+'\n');c.stdout.emit('data',JSON.stringify({type:'turn.completed'})+'\n');c.emit('close',0);await settle();};
 return {dir,root,db,calls,tasks,company,input,complete};
}
test('all public map functions have department owners and structured SOPs',()=>{
 assert.equal(COMPANY_SKILLS.length,31);assert.equal(new Set(COMPANY_SKILLS.map(s=>s.id)).size,31);
 for(const s of COMPANY_SKILLS){assert.ok(s.department&&s.archetype&&s.autonomy);for(const part of ['Name and trigger:','When to use:','Inputs:','Steps:','Handoff:'])assert.ok(s.prompt.includes(part));}
 for(const w of WORKFLOWS)for(const step of w.steps)assert.ok(COMPANY_SKILLS.some(s=>s.id===step)||['reviewer','writer'].includes(step));
 assert.equal(routeGoal('Build a website feature').workflow,'project-delivery');assert.equal(routeGoal('A confusing request').workflow,null);
});
test('shared brain only supplies the selected project and captures approved results',async t=>{
 const s=setup(t);s.tasks.brain.put({project:'one',title:'Brand voice',text:'Warm and factual.'});s.tasks.brain.put({project:'two',title:'Other client',text:'PRIVATE_OTHER_PROJECT'});
 const j=s.company.create(s.input);await settle();assert.match(s.calls[0].input,/Warm and factual/);assert.doesNotMatch(s.calls[0].input,/PRIVATE_OTHER_PROJECT/);
 const task=s.tasks.get(j.taskIds[0]);assert.equal(task.knowledgeIds.length,1);assert.throws(()=>s.tasks.brain.capture(task),/approved/);
 await s.complete();assert.throws(()=>s.tasks.brain.capture(s.tasks.get(task.id)),/approved/);s.tasks.review(task.id,'approved');const note=s.tasks.brain.capture(s.tasks.get(task.id));assert.equal(note.sourceTask,task.id);assert.equal(s.tasks.brain.capture(s.tasks.get(task.id)).id,note.id);assert.match(s.tasks.brain.export('one'),/Approved System Health Analyst/);
});
test('knowledge editing cannot move notes across projects; archive and restore are reversible',t=>{
 const s=setup(t);const n=s.tasks.brain.put({project:'one',title:'Offer',text:'Website delivery'});assert.throws(()=>s.tasks.brain.put({id:n.id,project:'two',title:'Moved',text:'x'}));
 s.tasks.brain.archive(n.id,true);assert.doesNotMatch(s.tasks.brain.context('one').text,/Website delivery/);s.tasks.brain.archive(n.id,false);assert.match(s.tasks.brain.context('one').text,/Website delivery/);
 s.tasks.brain.put({id:n.id,project:'one',title:'Offer',text:'Website and support'});assert.equal(s.tasks.brain.list('one').length,1);assert.throws(()=>s.tasks.brain.put({project:'../escape',title:'x',text:'y'}));
});
test('workflow never advances before approval, hands approved output to next stage, and closes explicitly',async t=>{
 const s=setup(t);let j=s.company.create(s.input);await settle();assert.equal(s.calls.length,1);assert.throws(()=>s.company.advance(j.id),/Approve/);await s.complete();assert.equal(s.company.get(j.id).status,'needs-review');assert.throws(()=>s.company.advance(j.id),/Approve/);assert.equal(s.calls.length,1);
 s.tasks.review(j.taskIds.at(-1),'approved');j=s.company.advance(j.id);await settle();assert.equal(j.stage,1);assert.equal(s.calls.length,2);assert.match(s.calls[1].input,/Previous stage, approved by the owner/);assert.match(s.calls[1].input,/Verified project findings/);assert.equal(s.tasks.brain.list('one').length,1);
 await s.complete();s.tasks.review(j.taskIds.at(-1),'approved');j=s.company.advance(j.id);await settle();await s.complete();s.tasks.review(j.taskIds.at(-1),'approved');j=s.company.advance(j.id);assert.equal(j.closed,true);assert.equal(j.status,'completed');assert.equal(s.calls.length,3);assert.equal(s.tasks.brain.list('one').length,3);assert.throws(()=>s.company.advance(j.id),/not open/);
});
test('rejected results cannot propagate and retries remain at the same stage',async t=>{
 const s=setup(t);const j=s.company.create(s.input);await settle();await s.complete();s.tasks.review(j.taskIds[0],'changes-requested');assert.equal(s.company.get(j.id).status,'needs-changes');assert.throws(()=>s.company.advance(j.id),/Approve/);const fresh=s.company.retry(j.id,{feedback:"Include verified dates"});assert.equal(fresh.stage,0);assert.equal(fresh.taskIds.length,2);await settle();assert.match(s.calls.at(-1).input,/Include verified dates/);assert.equal(s.tasks.brain.list('one').length,0);s.company.stop(j.id);assert.equal(s.company.get(j.id).closed,true);assert.equal(s.tasks.get(fresh.taskIds.at(-1)).status,'cancelling');
});
test('workflow validates access and a failed handoff rolls back both task and brain changes',async t=>{
 const s=setup(t);assert.throws(()=>s.company.create({...s.input,workflow:'project-delivery'}),/project-write/);assert.throws(()=>s.company.create({...s.input,mode:'workspace-write'}),/read-only/);assert.throws(()=>s.company.create({...s.input,project:'../x'}));assert.equal(s.company.list().length,0);
 const j=s.company.create(s.input);await settle();await s.complete();s.tasks.review(j.taskIds[0],'approved');s.tasks.close();assert.throws(()=>s.company.advance(j.id),/stopping/);assert.equal(s.company.get(j.id).stage,0);assert.equal(s.tasks.brain.list('one').length,0);assert.equal(s.tasks.list().length,1);
});
test('workflow survives restart as interrupted and never starts the next stage automatically',async t=>{
 const s=setup(t);const j=s.company.create(s.input);await settle();s.tasks.close();const tasks=createTasks({db:s.db,root:s.root,spawn:()=>assert.fail('must not launch')});const company=createCompany({db:s.db,tasks});assert.equal(company.get(j.id).status,'interrupted');assert.equal(company.get(j.id).stage,0);assert.equal(company.get(j.id).taskIds.length,1);tasks.close();
});
test('company and brain endpoints enforce browser guards and export actual SOP text',async t=>{
 const s=setup(t);const server=createApp({db:s.db,tasks:s.tasks,company:s.company,actions:{describe:()=>[],recentRuns:()=>[]},webDir:path.resolve('web')});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());const base=`http://127.0.0.1:${server.address().port}`;const headers={'Content-Type':'application/json',Origin:base,'x-ahq-nonce':server.nonce};
 for(const endpoint of ['/api/company/jobs','/api/brain','/api/brain/archive','/api/brain/capture']){
  assert.equal((await fetch(base+endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
  assert.equal((await fetch(base+endpoint,{method:'POST',headers,body:'{}'})).status,400);
 }
 const response=await fetch(base+'/api/company/jobs',{method:'POST',headers,body:JSON.stringify({...s.input,confirmed:true})});assert.equal(response.status,201);const {job}=await response.json();assert.equal((await fetch(base+`/api/company/${job.id}/advance`,{method:'POST',headers,body:JSON.stringify({confirmed:true})})).status,400);
 const skill=await fetch(base+'/api/company/skills/content-scout/export');assert.equal(skill.status,200);assert.match(await skill.text(),/Handoff:/);assert.equal((await fetch(base+'/company.js')).status,200);assert.equal((await fetch(base+'/api/brain?project=../x')).status,400);
});
