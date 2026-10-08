import test from 'node:test';import assert from 'node:assert/strict';import {matchesTaskFilter} from '../web/missions.js';
test('optional delivered review is complete work, not a blocker in the review inbox',()=>{const delivered={status:'review',reviewOptional:true};assert.equal(matchesTaskFilter(delivered,'completed'),true);assert.equal(matchesTaskFilter(delivered,'review'),false);assert.equal(matchesTaskFilter({status:'review'},'review'),true);assert.equal(matchesTaskFilter({status:'running'},'active'),true);});
import {stateLabel} from '../web/missions.js';
test('state labels keep owner rejections visible and earlier attempts distinct',()=>{
 assert.equal(stateLabel({status:'review',reviewOptional:true}),'DELIVERED');
 assert.equal(stateLabel({status:'completed',review:'changes-requested',reviewOptional:false}),'CHANGES REQUESTED');
 assert.equal(stateLabel({status:'completed',review:'changes-requested',supersededBy:'x'}),'EARLIER ATTEMPT');
 assert.equal(stateLabel({status:'completed',review:'approved'}),'COMPLETED');
});
