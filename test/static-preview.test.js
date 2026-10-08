import test from 'node:test';import http from 'node:http';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {createStaticPreviews,readVerified} from '../server/static-preview.js';
test('static preview is local, read-only, project scoped, and rejects sensitive paths and symlinks',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'hq-preview-')),dir=path.join(root,'site');await fs.mkdir(dir);await fs.writeFile(path.join(dir,'index.html'),'<h1>Preview</h1>');await fs.writeFile(path.join(dir,'app.js'),'console.log("preview")');await fs.writeFile(path.join(dir,'secret.js'),'secret');await fs.writeFile(path.join(root,'outside.js'),'outside');await fs.symlink(path.join(root,'outside.js'),path.join(dir,'linked.js'));const service=createStaticPreviews({root});t.after(()=>service.close());t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const [a,b]=await Promise.all([service.ensure('site'),service.ensure('site')]);assert.equal(a.url,b.url);assert.match(a.url,/^http:\/\/127\.0\.0\.1:\d+\/$/);assert.match(await(await fetch(a.url)).text(),/Preview/);
 for(const f of ['secret.js','linked.js','.env','%2e%2e/outside.js','package.json'])assert.equal((await fetch(a.url+f)).status,404,f);assert.equal((await fetch(a.url,{method:'POST'})).status,405);assert.equal(await new Promise(resolve=>http.get(a.url,{headers:{Host:'untrusted.invalid'}},r=>{r.resume();resolve(r.statusCode);})),403);await assert.rejects(()=>service.ensure('../site'));
});
test('unsupported server projects do not get a fabricated working preview',async t=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'hq-preview-none-'));await fs.mkdir(path.join(root,'app'));const s=createStaticPreviews({root});t.after(()=>s.close());t.after(()=>fs.rm(root,{recursive:true,force:true}));assert.equal(await s.ensure('app'),null);});

test('a built dist directory supports the conventional /dist/ URL without leaving its root',async t=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'hq-dist-')),dist=path.join(root,'site','dist');await fs.mkdir(dist,{recursive:true});await fs.writeFile(path.join(dist,'index.html'),'<h1>Built</h1>');await fs.writeFile(path.join(dist,'app.js'),'built');const s=createStaticPreviews({root});t.after(()=>s.close());t.after(()=>fs.rm(root,{recursive:true,force:true}));const p=await s.ensure('site');assert.match(await(await fetch(p.url+'dist/')).text(),/Built/);assert.equal(await(await fetch(p.url+'dist/app.js')).text(),'built');assert.equal((await fetch(p.url+'dist/.env')).status,404);});

test('script-free fixture omits executable scripts and applies stronger CSP without browser settings changes',async t=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'hq-noscript-'));await fs.mkdir(path.join(root,'site'));await fs.writeFile(path.join(root,'site','index.html'),'<h1>Static fallback</h1><script src="app.js"></script><script>unsafe()</script>');const s=createStaticPreviews({root});t.after(()=>s.close());t.after(()=>fs.rm(root,{recursive:true,force:true}));const p=await s.ensure('site'),response=await fetch(p.scriptFreeUrl),body=await response.text();assert.match(body,/Static fallback/);assert.doesNotMatch(body,/<script/i);assert.match(response.headers.get('content-security-policy'),/script-src 'none'/);});
test('a file replaced between validation and open is never served',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'hq-race-')),base=path.join(await fs.realpath(root),'site');await fs.mkdir(base);t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.writeFile(path.join(root,'outside.html'),'SECRET');
 const target=path.join(base,'index.html');
 await fs.writeFile(target,'ok');assert.equal((await readVerified(base,'index.html')).body.toString(),'ok');
 // symlink swapped in after validation: O_NOFOLLOW refuses it
 await assert.rejects(readVerified(base,'index.html',{beforeOpen:async real=>{await fs.rm(real);await fs.symlink(path.join(root,'outside.html'),real);}}));
 // a different regular file swapped in after validation: identity (dev/ino) check refuses it
 await fs.rm(target);await fs.writeFile(target,'ok');await fs.writeFile(path.join(root,'swap.html'),'SWAPPED');
 await assert.rejects(readVerified(base,'index.html',{beforeOpen:async real=>{await fs.rename(path.join(root,'swap.html'),real);}}));
});
test('a reused preview follows a later dist build and keeps sliding its expiry while used',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'hq-fresh-')),site=path.join(root,'site');await fs.mkdir(site);await fs.writeFile(path.join(site,'index.html'),'<h1>Source</h1>');
 const s=createStaticPreviews({root,ttlMs:300});t.after(()=>{s.close();return fs.rm(root,{recursive:true,force:true});});
 const a=await s.ensure('site');assert.match(await(await fetch(a.url)).text(),/Source/);
 await fs.mkdir(path.join(site,'dist'));await fs.writeFile(path.join(site,'dist','index.html'),'<h1>Built</h1>');
 const b=await s.ensure('site');assert.equal(b.url,a.url);assert.match(await(await fetch(b.url)).text(),/Built/);
 for(let i=0;i<4;i++){await new Promise(r=>setTimeout(r,150));assert.equal((await fetch(b.url)).status,200);}
});
