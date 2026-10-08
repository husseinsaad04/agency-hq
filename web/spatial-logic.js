// Shared, renderer-independent spatial state. No simulated task activity.
export const FLOOR_ORDER = ['Operations','Sales','Marketing','Design','Product','Engineering','Quality Assurance','Game Development','Spatial Computing','Specialized Ops','Leadership'];
const DEPARTMENTS = {os:'Operations',content:'Marketing',sales:'Sales',comms:'Operations',finance:'Operations',personal:'Operations',delivery:'Engineering'};
const BASE = {researcher:'Specialized Ops',builder:'Engineering',reviewer:'Quality Assurance',writer:'Marketing',planner:'Product',tester:'Quality Assurance'};
export function residents(skills) {
 return skills.map(({id,name,department,description})=>({id,name,description,department:DEPARTMENTS[department]||department||BASE[id]||'Specialized Ops'}));
}
export function departments(roles) {
 const found=[...new Set(roles.map(r=>r.department))];
 return FLOOR_ORDER.filter(d=>found.includes(d)).concat(found.filter(d=>!FLOOR_ORDER.includes(d)));
}
export function assignmentFor(id,tasks,taskId=null) {
 if(taskId)return tasks.find(t=>t.id===taskId&&t.skill===id)||null;
 const priority={running:0,cancelling:1,queued:2,review:3};
 return tasks.filter(t=>t.skill===id).sort((a,b)=>(priority[a.status]??4)-(priority[b.status]??4)||(b.createdAt||0)-(a.createdAt||0))[0]||null;
}
export function residentState(id,tasks) {
 const t=assignmentFor(id,tasks);
 if(!t)return 'available';
 if(['running','cancelling','queued','review','failed','interrupted'].includes(t.status))return t.status;
 if(t.review==='changes-requested')return 'changes-requested';
 return 'available';
}
export function floorPlan(roles) {
 const ds=departments(roles);
 const cols=6,cellWidth=5.8,cellDepth=5.2;
 const floors=ds.map((name,index)=>{
  const team=roles.filter(r=>r.department===name),rows=Math.max(2,Math.ceil(team.length/cols)),depth=rows*cellDepth+13;
  return {name,index,depth,rows,residents:team.map((r,i)=>({...r,x:team.length===1?0:(i%cols-(cols-1)/2)*cellWidth,z:depth/2-4.1-Math.floor(i/cols)*cellDepth,office:i+1}))};
 });
 return {width:cols*cellWidth+6,depth:Math.max(23.4,...floors.map(f=>f.depth)),floors};
}
export function workstationText(role,task) {
 return [role.name, task?.status?.toUpperCase()||'AVAILABLE',task?.title||'No assignment',task?.activity||'Assign work from HQ'];
}

export function workstationDetail(roleId,task,detail) {
 return task&&detail?.id===task.id&&detail.skill===roleId?detail:null;
}
