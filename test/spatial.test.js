import test from 'node:test';
import assert from 'node:assert/strict';
import {residents,departments,floorPlan,assignmentFor,residentState,workstationText,workstationDetail} from '../web/spatial-logic.js';

test('opening a task pins that exact resident assignment without substituting another run',()=>{
 const tasks=[{id:'running',skill:'a',status:'running',createdAt:1},{id:'queued',skill:'a',status:'queued',createdAt:2},{id:'other',skill:'b',status:'running'}];
 assert.equal(assignmentFor('a',tasks,'queued').id,'queued');
 assert.equal(assignmentFor('a',tasks,'other'),null);
 assert.equal(assignmentFor('a',tasks,'missing'),null);
 assert.equal(assignmentFor('a',tasks).id,'running');
});
test('every original and imported role retains its ID and occupies exactly one office',()=>{
 const skills=[{id:'builder',name:'Builder'},{id:'system-auditor',name:'Auditor',department:'os'},...Array.from({length:167},(_,i)=>({id:`paperclip-${i}`,name:`Role ${i}`,department:i%2?'Marketing':'Engineering'}))];
 const roles=residents(skills),plan=floorPlan(roles),offices=plan.floors.flatMap(f=>f.residents);
 assert.equal(offices.length,skills.length);assert.equal(new Set(offices.map(r=>r.id)).size,skills.length);
 assert.deepEqual(new Set(offices.map(r=>r.id)),new Set(skills.map(r=>r.id)));
 for(const floor of plan.floors){assert.equal(new Set(floor.residents.map(r=>`${r.x},${r.z}`)).size,floor.residents.length);for(const r of floor.residents){assert.ok(Math.abs(r.x)<plan.width/2);assert.ok(Math.abs(r.z)<plan.depth/2);}}
 assert.deepEqual(departments(roles),['Operations','Marketing','Engineering']);
});
test('a running assignment wins over a newer queue item and another role never leaks into a screen',()=>{
 const tasks=[{id:'other',skill:'b',status:'running',title:'Other client'},{id:'q',skill:'a',status:'queued',createdAt:20},{id:'r',skill:'a',status:'running',createdAt:10}];
 assert.equal(assignmentFor('a',tasks).id,'r');assert.equal(residentState('a',tasks),'running');assert.equal(assignmentFor('absent',tasks),null);
 assert.deepEqual(workstationText({name:'Researcher'},null),['Researcher','AVAILABLE','No assignment','Assign work from HQ']);
});
test('execution and human-review states remain distinct in the building',()=>{
 for(const status of ['queued','running','cancelling','review','failed','interrupted'])assert.equal(residentState('a',[{skill:'a',status}]),status);
 assert.equal(residentState('a',[{skill:'a',status:'completed',review:'changes-requested'}]),'changes-requested');
 assert.equal(residentState('a',[{skill:'a',status:'completed',review:'approved'}]),'available');
 assert.equal(residentState('a',[]),'available');
});

test('workstation rejects stale-run and wrong-resident details',()=>{
 const task={id:'current',skill:'a'};
 assert.equal(workstationDetail('a',task,{id:'previous',skill:'a',result:'old'}),null);
 assert.equal(workstationDetail('a',task,{id:'current',skill:'b',result:'other role'}),null);
 const detail={id:'current',skill:'a',result:'own public output'};
 assert.equal(workstationDetail('a',task,detail),detail);
 assert.equal(workstationDetail('a',null,detail),null);
});


test('floor depth follows team size and keeps every office clear of the hospitality strip',()=>{
 const roles=residents([{id:'ceo',name:'CEO',department:'Leadership'},...Array.from({length:43},(_,i)=>({id:`m${i}`,name:'Marketer',department:'Marketing'}))]);
 const plan=floorPlan(roles),small=plan.floors.find(f=>f.name==='Leadership'),large=plan.floors.find(f=>f.name==='Marketing');
 assert.ok(small.depth<large.depth);assert.equal(large.rows,8);
 for(const f of plan.floors)for(const r of f.residents){assert.ok(r.z-2.1> -f.depth/2+7.7,'office must not intersect rear meeting and lounge strip');assert.ok(r.z+2.1<f.depth/2);assert.ok(Math.abs(r.x)+2.6<plan.width/2);}
});
