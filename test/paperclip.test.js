import test from 'node:test';
import assert from 'node:assert/strict';
import {openDb} from '../server/db.js';
import {createPaperclip,paperclipStatus,loadPaperclipConnection} from '../server/paperclip.js';
import {resolveProject,listProjects} from '../server/actions.js';
import {createTasks} from '../server/tasks.js';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const cid='f2c64a6e-8967-4d31-90df-8b40bcbb49c0',aid='0e8c5676-1ba0-4200-b414-4acd9b1223eb';
const role={id:'paperclip-'+aid,name:'Imported expert',prompt:'Use evidence from project context.',paperclipAgentId:aid,paperclipCompanyId:cid};
const connection={baseUrl:'http://127.0.0.1:3100',companyId:cid,companyName:'HQ',issuePrefix:'AGE',roles:[role]};
test('bridge mirrors actual tasks, uses idempotency, and does not mark unapproved results done',async t=>{
 const db=openDb(':memory:');t.after(()=>db.close());let task={id:'task-1',paperclipCompanyId:cid,paperclipAgentId:aid,title:'Inspect',instructions:'Read a project file',project:'one',runtime:'codex',mode:'read-only',budgetMinutes:5,status:'running',result:'',activity:'Reading',review:null};const calls=[];
 const fetchImpl=async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>url.endsWith('/health')?{status:'ok'}:url.endsWith('/projects')?(options.method==='GET'?[]:{id:'project-1'}):options.method==='POST'?{id:'issue-1',identifier:'AGE-1'}:{}};};
 const bridge=createPaperclip({db,tasks:{list:()=>[task]},connection,fetchImpl});await bridge.sync();const first=calls.find(c=>c.options.method==='POST'&&c.url.endsWith('/issues'));const body=JSON.parse(first.options.body);assert.equal(body.idempotencyKey,'hq-task-task-1');assert.equal(body.assigneeAgentId,aid);assert.equal(body.projectId,'project-1');assert.equal(body.status,'in_progress');assert.match(body.description,/HQ-managed/);
 task={...task,status:'review',result:'Verified public result'};await bridge.sync();assert.equal(JSON.parse(calls.at(-1).options.body).status,'in_review');assert.match(calls.at(-1).options.body,/Verified public result/);
 task={...task,status:'completed',review:'changes-requested'};await bridge.sync();assert.equal(JSON.parse(calls.at(-1).options.body).status,'blocked');task={...task,review:'approved'};await bridge.sync();assert.equal(JSON.parse(calls.at(-1).options.body).status,'done');assert.equal(calls.filter(c=>c.options.method==='POST'&&c.url.endsWith('/issues')).length,1);
 const before=calls.filter(c=>c.options.method==='PATCH').length;await bridge.sync();assert.equal(calls.filter(c=>c.options.method==='PATCH').length,before);assert.equal(bridge.overview().healthy,true);assert.equal(bridge.overview().roles[0].prompt,undefined);
});
test('connection failure preserves task execution and retries failed mirror operations',async t=>{
 const db=openDb(':memory:');t.after(()=>db.close());let fail=true;const task={id:'t',paperclipCompanyId:cid,paperclipAgentId:aid,status:'queued',result:'',title:'X',instructions:'Y'};const calls=[];
 const bridge=createPaperclip({db,tasks:{list:()=>[task]},connection,fetchImpl:async(url,o)=>{calls.push(o);if(fail)throw new Error('offline');return {ok:true,json:async()=>url.endsWith('/health')?{status:'ok'}:o.method==='POST'?{id:'i',identifier:'AGE-2'}:{}};}});
 await bridge.sync();assert.equal(bridge.overview().healthy,false);assert.match(bridge.overview().error,/offline/);assert.equal(task.status,'queued');fail=false;await bridge.sync();assert.equal(bridge.overview().healthy,true);assert.equal(bridge.overview().links[0].issueId,'i');
});
test('bridge ignores non-company tasks, wrong companies and unregistered roles',async t=>{
 const db=openDb(':memory:');t.after(()=>db.close());let mutations=0;const tasks={list:()=>[{id:'1'},{id:'2',paperclipCompanyId:'other',paperclipAgentId:aid},{id:'3',paperclipCompanyId:cid,paperclipAgentId:'unknown'}]};const bridge=createPaperclip({db,tasks,connection,fetchImpl:async(url,o)=>{if(o.method!=='GET')mutations++;return{ok:true,json:async()=>({status:'ok'})};}});await bridge.sync();assert.equal(mutations,0);assert.equal(bridge.overview().links.length,0);assert.equal(paperclipStatus({status:'interrupted'}),'blocked');assert.equal(paperclipStatus({status:'cancelled'}),'cancelled');
});
test('imported role dispatch keeps fixed CLI and records the actual Paperclip identity',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hq-import-'));fs.mkdirSync(path.join(dir,'one'));const db=openDb(':memory:');let received;const spawn=(file,args,options)=>{const c=new EventEmitter();c.stdout=new EventEmitter();c.stderr=new EventEmitter();c.stdin=new EventEmitter();c.stdin.end=prompt=>{received={file,args,prompt};};c.kill=()=>{};return c;};const runner=createTasks({db,root:dir,spawn,extraSkills:()=>[role]});t.after(()=>{runner.close();db.close();fs.rmSync(dir,{recursive:true,force:true});});
 const task=runner.create({title:'Inspect',instructions:'Check README',project:'one',runtime:'codex',mode:'read-only',skill:role.id});await new Promise(r=>setImmediate(r));assert.equal(task.paperclipAgentId,aid);assert.equal(task.paperclipCompanyId,cid);assert.equal(received.file,'/opt/homebrew/bin/codex');assert.ok(received.args.includes('read-only'));assert.match(received.prompt,/Use evidence/);
});
test('connection loader rejects remote hosts and wrong-company role records',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hq-pc-config-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const roleFile=path.join(dir,'roles.json'),configFile=path.join(dir,'connection.json');fs.writeFileSync(roleFile,JSON.stringify([role,{...role,paperclipCompanyId:'other'}]));fs.writeFileSync(configFile,JSON.stringify({...connection,roleFile}));assert.equal(loadPaperclipConnection(configFile).roles.length,1);fs.writeFileSync(configFile,JSON.stringify({...connection,roleFile,baseUrl:'https://example.com'}));assert.equal(loadPaperclipConnection(configFile),null);
});

test('service data is excluded from agent workspaces, including symlink aliases',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hq-services-boundary-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));fs.mkdirSync(path.join(dir,'agency-hq-services'));fs.mkdirSync(path.join(dir,'client'));fs.symlinkSync(path.join(dir,'agency-hq-services'),path.join(dir,'alias'));assert.deepEqual(listProjects(dir),['client']);assert.throws(()=>resolveProject('agency-hq-services',dir));assert.throws(()=>resolveProject('alias',dir),/service data/);
});
