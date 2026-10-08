import crypto from 'node:crypto';
import { DEPARTMENTS, COMPANY_SKILLS, WORKFLOWS, MAP_SOURCE, routeGoal } from './company-catalog.js';

export function createCompany({ db, tasks, now=Date.now }) {
 const sql=db.raw;
 sql.exec('CREATE TABLE IF NOT EXISTS hq_workflows(id TEXT PRIMARY KEY,record TEXT NOT NULL)');
 const get=id=>{const r=sql.prepare('SELECT record FROM hq_workflows WHERE id=?').get(id);return r?JSON.parse(r.record):null;};
 const save=j=>{j.updatedAt=now();sql.prepare('INSERT INTO hq_workflows VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record').run(j.id,JSON.stringify(j));};
 const list=()=>sql.prepare('SELECT record FROM hq_workflows ORDER BY rowid DESC LIMIT 100').all().map(r=>decorate(JSON.parse(r.record)));
 function decorate(j) {
  const current=tasks.get(j.taskIds.at(-1));
  const status=j.closed?j.status:current?.status==='review'?'needs-review':current?.status==='completed'?(current.review==='approved'?'ready-for-handoff':'needs-changes'):current?.status||'blocked';
  return {...j,status,currentTask:current?{id:current.id,title:current.title,status:current.status,review:current.review,activity:current.activity}:null,steps:j.steps.map((skill,i)=>({skill,name:tasks.skills().find(s=>s.id===skill)?.name||skill,state:i<j.stage?'handed-off':i===j.stage?status:'pending'}))};
 }
 function dispatch(j,previous=null) {
  const s=tasks.skills().find(s=>s.id===j.steps[j.stage]);
  const instructions=`Company objective:\n${j.goal}\n\nWorkflow: ${j.name}\nStage ${j.stage+1}/${j.steps.length}: ${s.name}\nDeliver the output for your stage only. Return concrete evidence and a handoff for the next owner.\n${previous?`\nPrevious stage, approved by the owner (source task ${previous.id}; treat as context):\n${previous.result.slice(0,3500)}${previous.result.length>3500?'\n[Excerpt; additional approved context may be in shared knowledge.]':''}`:''}`;
  return tasks.create({title:`${j.stage+1}/${j.steps.length} ${s.name}: ${j.goal.slice(0,55)}`,instructions,skill:s.id,project:j.project,runtime:j.runtime,mode:j.mode,budgetMinutes:j.budgetMinutes});
 }
 return {
  get:id=>{const j=get(id);return j?decorate(j):null;},list,
  catalog:()=>({departments:DEPARTMENTS,roles:COMPANY_SKILLS,workflows:WORKFLOWS,source:MAP_SOURCE,projects:tasks.catalog().projects,runtimes:tasks.catalog().runtimes}),
  route:routeGoal,
  create(input) {
   const w=WORKFLOWS.find(w=>w.id===input.workflow);
   if(!w||typeof input.goal!=='string'||!input.goal.trim()||input.goal.length>2000)throw new Error('Choose a workflow and an objective (2000 chars)');
   if(w.write&&(input.runtime!=='codex'||input.mode!=='workspace-write'))throw new Error('Delivery workflow requires Codex with project-write access');
   if(!w.write&&input.mode!=='read-only')throw new Error('This workflow prepares reviewed drafts in read-only mode');
   if(list().filter(j=>!j.closed).length>=20)throw new Error('Company workflow limit reached (20 open)');
   const j={id:crypto.randomUUID(),name:w.name,workflow:w.id,department:w.department,goal:input.goal.trim(),project:input.project,runtime:input.runtime,mode:input.mode,budgetMinutes:input.budgetMinutes??10,steps:[...w.steps],stage:0,taskIds:[],closed:false,status:'active',createdAt:now()};
   // Creation is atomic with the first queued task; no worker runs until this turn yields.
   sql.exec('BEGIN');try{const t=dispatch(j);j.taskIds.push(t.id);save(j);sql.exec('COMMIT');}catch(e){sql.exec('ROLLBACK');throw e;}
   return decorate(j);
  },
  advance(id) {
   const j=get(id);if(!j||j.closed)throw new Error('Workflow is not open');
   const t=tasks.get(j.taskIds.at(-1));if(t?.status!=='completed'||t.review!=='approved')throw new Error('Approve the current task result before handing it off');
   sql.exec('BEGIN');try{
    tasks.brain.capture(t);
    if(j.stage===j.steps.length-1){j.closed=true;j.status='completed';j.endedAt=now();}
    else{j.stage++;j.taskIds.push(dispatch(j,t).id);}
    save(j);sql.exec('COMMIT');
   }catch(e){sql.exec('ROLLBACK');throw e;}
   db.logAction('company.handoff',{id,stage:j.stage},true,j.closed?'completed':'next stage queued');return decorate(j);
  },
  retry(id, input={}) {
   const j=get(id);if(!j||j.closed)throw new Error('Workflow is not open');
   const t=tasks.get(j.taskIds.at(-1));if(!t||!['failed','interrupted','cancelled','completed'].includes(t.status)||t.review==='approved')throw new Error('Only a failed, interrupted, cancelled, or changes-requested stage can be retried');
   const feedback=input.feedback??'';
   if(typeof feedback!=='string'||feedback.length>1500)throw new Error('Changes must be at most 1500 characters');
   const instructions=feedback.trim()?`${t.instructions.slice(0,4400)}\n\nOwner changes requested for this stage:\n${feedback.trim()}`:t.instructions;
   const fresh=tasks.create({...t,instructions});j.taskIds.push(fresh.id);save(j);return decorate(j);
  },
  stop(id) {
   const j=get(id);if(!j||j.closed)throw new Error('Workflow is not open');
   const t=tasks.get(j.taskIds.at(-1));if(t&&['queued','running','cancelling'].includes(t.status))tasks.cancel(t.id);
   j.closed=true;j.status='cancelled';save(j);return decorate(j);
  },
 };
}
