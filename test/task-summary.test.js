import test from 'node:test';
import assert from 'node:assert/strict';
import {taskSummary} from '../web/task-summary.js';
test('summary uses final public reply and keeps failed review evidence despite approved task status',()=>{
 const s=taskSummary({status:'completed',review:'approved',result:'Old progress',events:[{kind:'message',text:'I am starting.'},{kind:'tool',text:'Secret tool body'},{kind:'message',text:'**Recovery review: FAIL. Posting should remain held.**\n\nValidation: 170 tests passed.\n\nFix the older endpoint before approving recovery.'}]});
 assert.match(s.outcome,/FAIL/);assert.match(s.checks.join(' '),/170 tests passed/);assert.match(s.outcome,/held/);assert.match(s.attention.join(' '),/older endpoint/);assert.doesNotMatch(JSON.stringify(s),/Secret|starting/);
});
test('stopped task is explicitly partial even when latest update says tests pass',()=>{
 const s=taskSummary({status:'failed',activity:'Time budget reached.',events:[{kind:'message',text:'The tests passed. I am finishing.'}]});
 assert.equal(s.label,'Partial result');assert.match(s.outcome,/Time budget reached/);
});
test('structured summary excludes optional details while retaining checks and next step',()=>{
 const s=taskSummary({status:'review',events:[{kind:'message',text:'Outcome\nAdded recovery controls.\n\nChecks\n- 12 passed; Python blocked.\n\nNext step\n- Review before deployment.\n\nDetails\nLong command history here.'}]});
 assert.equal(s.outcome,'Added recovery controls.');assert.deepEqual(s.checks,['12 passed; Python blocked.']);assert.deepEqual(s.attention,['Review before deployment.']);assert.doesNotMatch(JSON.stringify(s),/command history/);
});
test('handoff decision stays visible and protocol lines do not clutter the summary',()=>{
 const s=taskSummary({status:'review',result:'Outcome\nDashboard complete.\n\nChecks\n174 tests passed.\nCHECKS_PASSED: YES\n\nNext step\nReview the local dashboard.\nHANDOFF_READY: YES'});
 assert.equal(s.handoff.state,'ready');assert.equal(s.handoff.label,'Handoff ready: Yes');
 assert.deepEqual(s.checks,['174 tests passed.']);assert.deepEqual(s.attention,['Review the local dashboard.']);
 const blocked=taskSummary({status:'review',review:'approved',result:'HANDOFF_READY: YES\nCHECKS_PASSED: NO'});
 assert.equal(blocked.handoff.state,'blocked');
 assert.equal(taskSummary({status:'completed',review:'approved',result:'HANDOFF_READY: NO'}).handoff.state,'blocked');
});
test('readiness is never inferred from approval, progress, tool events or quoted examples',()=>{
 assert.equal(taskSummary({status:'completed',review:'approved',result:'Everything passed.'}).handoff.state,'unconfirmed');
 assert.equal(taskSummary({status:'running',result:'HANDOFF_READY: YES'}).handoff.state,'pending');
 assert.equal(taskSummary({status:'failed',result:'HANDOFF_READY: YES'}).handoff.state,'blocked');
 assert.equal(taskSummary({status:'review',events:[{kind:'message',text:'Working.'},{kind:'tool',text:'HANDOFF_READY: YES'}]}).handoff.state,'unconfirmed');
 assert.equal(taskSummary({status:'review',result:'Example:\n```\nHANDOFF_READY: YES\n```'}).handoff.state,'unconfirmed');
 assert.equal(taskSummary({status:'review',result:'HANDOFF_READY: YES\nHANDOFF_READY: NO'}).handoff.state,'blocked');
});
import {taskSummary as summarize} from '../web/task-summary.js';
test('summary agrees with the workflow parser and separates optional gaps from blockers',()=>{
 const mk=text=>summarize({status:'review',events:[{kind:'message',text}],result:''});
 assert.equal(mk('Outcome\nDone.\n**HANDOFF_READY:** YES — all stages ok').handoff.state,'ready');
 assert.equal(mk('Outcome\nDone.\n```\nHANDOFF_READY: YES\n```').handoff.state,'unconfirmed');
 assert.equal(mk('HANDOFF_READY: YES\nHANDOFF_READY: NO').handoff.state,'blocked');
 assert.equal(mk('HANDOFF_READY: YES\nCHECKS_PASSED: NO').handoff.state,'blocked');
 const s=mk('Outcome\nDone.\nOPTIONAL_GAPS: toolbar zoom not verified\nHANDOFF_READY: YES');
 assert.equal(s.handoff.state,'ready');assert.deepEqual(s.gaps,['toolbar zoom not verified']);assert.doesNotMatch(s.outcome,/OPTIONAL_GAPS/);
});
