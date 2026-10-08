import fs from 'node:fs';
import path from 'node:path';
import { CONFIG, HOME } from './config.js';

export function loadPaperclipConnection(file=path.join(HOME,'Projects/agency-hq-services/paperclip-connection.json')) {
 try {
  const config=JSON.parse(fs.readFileSync(file,'utf8'));
  if(config.baseUrl!=='http://127.0.0.1:3100'||!/^\w{8}-[a-f0-9-]{27}$/i.test(config.companyId))throw new Error('Invalid local Paperclip configuration');
  const roles=JSON.parse(fs.readFileSync(config.roleFile,'utf8'));
  if(!Array.isArray(roles)||roles.length>300)throw new Error('Invalid imported roster');
  return {...config,roles:roles.filter(r=>r.paperclipCompanyId===config.companyId&&r.id==='paperclip-'+r.paperclipAgentId&&typeof r.prompt==='string'&&r.prompt.length<24000)};
 } catch {return null;}
}
export function paperclipStatus(t) {
 if(t.status==='completed')return t.review==='approved'?'done':'blocked';
 return {queued:'todo',running:'in_progress',cancelling:'in_progress',review:'in_review',failed:'blocked',interrupted:'blocked',cancelled:'cancelled'}[t.status]||'backlog';
}
export function createPaperclip({db,tasks,connection,fetchImpl=fetch,now=Date.now}) {
 db.raw.exec('CREATE TABLE IF NOT EXISTS hq_paperclip_links(task_id TEXT PRIMARY KEY,record TEXT NOT NULL)');
 let busy=false,healthy=false,error='',lastSync=null;
 const get=id=>{const r=db.raw.prepare('SELECT record FROM hq_paperclip_links WHERE task_id=?').get(id);return r?JSON.parse(r.record):null;};
 const save=r=>db.raw.prepare('INSERT INTO hq_paperclip_links VALUES(?,?) ON CONFLICT(task_id) DO UPDATE SET record=excluded.record').run(r.taskId,JSON.stringify(r));
 const request=async(endpoint,method='GET',body)=>{
  const r=await fetchImpl(connection.baseUrl+'/api'+endpoint,{method,headers:{'Content-Type':'application/json',Origin:connection.baseUrl},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(8000)});
  if(!r.ok)throw new Error(`Paperclip ${method} returned ${r.status}`);
  return r.json();
 };
 function description(t) {
  return `HQ-managed assignment: ${t.id}\nProject: ${t.project}\nRuntime: ${t.runtime}\nAccess: ${t.mode}\nBudget: ${t.budgetMinutes} minutes\n\n${t.instructions}\n\nHQ status: ${t.status}\nActivity: ${t.activity}\nReview: ${t.review||'pending'}\n\nLive tools, cancellation, and result approval: http://127.0.0.1:7777/\n\n${t.result?`Public result:\n${t.result.slice(-40000)}`:'Result pending.'}`;
 }
 return {
  connection,
  overview(){return {configured:!!connection,healthy,error,lastSync,baseUrl:connection?.baseUrl||null,company:connection?{id:connection.companyId,name:connection.companyName,issuePrefix:connection.issuePrefix}:null,roles:connection?.roles.map(({prompt,sourceFile,...r})=>r)||[],links:db.raw.prepare('SELECT record FROM hq_paperclip_links ORDER BY rowid DESC LIMIT 100').all().map(r=>{const {stamp,...safe}=JSON.parse(r.record);return safe;})};},
  async sync(){
   if(!connection||busy)return;busy=true;
   try {
    const h=await request('/health');if(h.status!=='ok')throw new Error('Paperclip is not ready');healthy=true;
    for(const t of tasks.list()) {
     if(t.paperclipCompanyId!==connection.companyId||!connection.roles.some(r=>r.paperclipAgentId===t.paperclipAgentId))continue;
     let link=get(t.id)||{taskId:t.id,issueId:null,identifier:null,syncedAt:null,status:null,error:null};
     try {
      if(!link.projectId&&t.project){
       const projects=await request(`/companies/${connection.companyId}/projects`);
       let project=projects.find(p=>p.name===`HQ / ${t.project}`&&p.description===`HQ-managed project: ${t.project}. Execution and result review remain in Agency HQ.`);
       if(!project)project=await request(`/companies/${connection.companyId}/projects`,'POST',{name:`HQ / ${t.project}`,description:`HQ-managed project: ${t.project}. Execution and result review remain in Agency HQ.`});
       link.projectId=project.id;save(link);link.stamp=null;
      }
      if(!link.issueId){
       const issue=await request(`/companies/${connection.companyId}/issues`,'POST',{title:t.title,description:description(t),assigneeAgentId:t.paperclipAgentId,...(link.projectId?{projectId:link.projectId}:{}),status:paperclipStatus(t),priority:'medium',idempotencyKey:`hq-task-${t.id}`,allowDuplicate:true});
       link.issueId=issue.id;link.identifier=issue.identifier;save(link);
      }
      // Update only the latest snapshot. HQ remains the execution/review authority.
      const stamp=JSON.stringify([t.status,t.review,t.activity,t.result]);
      if(link.stamp!==stamp){await request(`/issues/${link.issueId}`,'PATCH',{status:paperclipStatus(t),description:description(t),...(link.projectId?{projectId:link.projectId}:{})});link.stamp=stamp;}
      link.status=paperclipStatus(t);link.syncedAt=now();link.error=null;save(link);
     }catch(e){link.error=e.message;save(link);throw e;}
    }
    lastSync=now();error='';
   }catch(e){healthy=false;error=e.message;}finally{busy=false;}
  },
 };
}
