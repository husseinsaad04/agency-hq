import test from 'node:test';
import assert from 'node:assert/strict';
import {createProjectRequestId} from '../web/project-chat.js';

test('private HTTP browsers create a secure UUID without randomUUID',()=>{
 let fills=0;
 const cryptoApi={getRandomValues:bytes=>{fills++;bytes.fill(255);return bytes;}};
 assert.equal(createProjectRequestId(cryptoApi),'ffffffff-ffff-4fff-bfff-ffffffffffff');
 assert.equal(fills,1);
 assert.match(createProjectRequestId(),/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
});
test('secure contexts use randomUUID and missing browser crypto fails explicitly',()=>{
 assert.equal(createProjectRequestId({randomUUID:()=> 'native-id'}),'native-id');
 assert.throws(()=>createProjectRequestId({}),/secure project request/);
});
