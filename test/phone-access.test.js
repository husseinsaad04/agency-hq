import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {createApp} from '../server/app.js';
import {phoneRequest,validatePhoneAccess} from '../server/phone-access.js';

const access={origin:'http://macbook-pro.tailtest.ts.net:7778',login:'owner@example.com'};
const host=new URL(access.origin).host;
const identity={Host:host,'X-Forwarded-Host':host,'X-Forwarded-For':'100.64.0.2','Tailscale-User-Login':access.login};
function request(port,headers={},method='GET',body=null,path='/') {
  return new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port,path,method,headers:{Host:`127.0.0.1:${port}`,...headers}},res=>{
      let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,text}));
    });req.on('error',reject);if(body)req.write(JSON.stringify(body));req.end();
  });
}
async function fixture(phoneAccess) {
  const calls=[];
  const server=createApp({db:{},actions:{},webDir:fileURLToPath(new URL('../web/',import.meta.url)),phoneAccess,projectChat:{create:b=>{calls.push(b);return{id:'test'};}}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  return{server,port:server.address().port,calls};
}
test('private phone reads require the exact owner, host, and loopback proxy',async t=>{
  const f=await fixture(access);t.after(()=>f.server.close());
  assert.equal((await request(f.port)).status,200);
  assert.equal((await request(f.port,identity)).status,200);
  for(const headers of [{Host:host},{...identity,'Tailscale-User-Login':'other@example.com'},{...identity,'X-Forwarded-Host':'evil.example'},{...identity,Host:`127.0.0.1:${f.port}`}]) assert.equal((await request(f.port,headers)).status,403);
  assert.equal(phoneRequest({headers:Object.fromEntries(Object.entries(identity).map(([k,v])=>[k.toLowerCase(),v])),socket:{remoteAddress:'192.168.1.2'}},validatePhoneAccess(access)).allowed,false);
  assert.equal((await request(f.port,identity,'POST',{},'/api/hook')).status,403);
});
test('phone dispatch keeps exact origin, nonce, JSON and explicit confirmation guards',async t=>{
  const f=await fixture(access);t.after(()=>f.server.close());
  const h={...identity,Origin:access.origin,'x-ahq-nonce':f.server.nonce,'Content-Type':'application/json'};
  for(const [headers,body] of [[{...h,Origin:'http://evil.example'},{confirmed:true}],[{...h,Origin:`http://127.0.0.1:${f.port}`},{confirmed:true}],[{...h,'x-ahq-nonce':'wrong'},{confirmed:true}],[{...h,'Content-Type':'text/plain'},{confirmed:true}],[h,{confirmed:false}]]) assert.notEqual((await request(f.port,headers,'POST',body,'/api/project-chat')).status,200);
  assert.equal(f.calls.length,0);
  assert.equal((await request(f.port,h,'POST',{confirmed:true,goal:'Fixture only'},'/api/project-chat')).status,200);
  assert.equal(f.calls.length,1);
});
test('remote access is off by default and configuration cannot accept a public hostname',async t=>{
  const f=await fixture(null);t.after(()=>f.server.close());
  assert.equal((await request(f.port,identity)).status,403);
  assert.equal((await request(f.port,{'X-Forwarded-Host':host})).status,403);
  for(const origin of ['https://example.com','http://macbook-pro.tailtest.ts.net:7778/path','https://owner:secret@macbook-pro.tailtest.ts.net']) assert.throws(()=>validatePhoneAccess({...access,origin}));
});
