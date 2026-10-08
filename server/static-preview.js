import fs from 'node:fs/promises';
import {constants as C} from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {resolveProject} from './actions.js';
import {CONFIG} from './config.js';
const TYPES={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.ico':'image/x-icon','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf'};
async function regular(base,relative){
 const parts=relative.split('/');if(parts.some(p=>!p||p==='.'||p==='..'||p.startsWith('.')||/secret|credential|token|backup|private|package\.json|config\./i.test(p)))throw Error('unavailable');
 let file=base;for(const p of parts){file=path.join(file,p);if((await fs.lstat(file)).isSymbolicLink())throw Error('unavailable');}
 const real=await fs.realpath(file),stat=await fs.stat(real);if(!real.startsWith(base+path.sep)||!stat.isFile()||stat.size>5_000_000||!TYPES[path.extname(real)])throw Error('unavailable');return real;
}
// Open the validated file without following links and prove the handle is the file that was validated,
// so a replacement between validation and read (symlink, swapped file) cannot widen what is served.
export async function readVerified(base,relative,hooks={}){
 const real=await regular(base,relative),expected=await fs.stat(real);
 await hooks.beforeOpen?.(real); // test seam: simulates a replacement landing between validation and open
 const handle=await fs.open(real,C.O_RDONLY|C.O_NOFOLLOW);
 try{
  const opened=await handle.stat();
  if(!opened.isFile()||opened.size>5_000_000||opened.dev!==expected.dev||opened.ino!==expected.ino)throw Error('unavailable');
  const body=await handle.readFile();
  if(body.length>5_000_000||await fs.realpath(real).catch(()=>null)!==real)throw Error('unavailable');
  return {file:real,body};
 }finally{await handle.close();}
}
export function createStaticPreviews({root=CONFIG.projectsDir,db,ttlMs=45*60_000}={}){
 const active=new Map(),starting=new Map();let closed=false;
 // Sliding expiry: an open preview that is still being used stays alive; an idle one closes.
 function arm(project,entry){clearTimeout(entry.timer);entry.timer=setTimeout(()=>{entry.server.close();if(active.get(project)===entry)active.delete(project);},ttlMs);entry.timer.unref();}
 function touch(project){const e=active.get(project);if(e)arm(project,e);}
 // dist/ wins over the project root once a build exists; re-evaluated while a preview is reused.
 async function selectBase(dir){
  for(const candidate of [path.join(dir,'dist'),dir])try{if((await fs.lstat(candidate)).isSymbolicLink())continue;await regular(candidate,'index.html');return candidate;}catch{}
  return null;
 }
 async function start(project){
  const dir=await fs.realpath(resolveProject(project,root));const base=await selectBase(dir);
  if(!base||closed)return null;
  const entry={base,dir};
  const server=http.createServer(async(req,res)=>{
   const headers={'X-Content-Type-Options':'nosniff','Cache-Control':'no-store','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'"};
   if(![`127.0.0.1:${server.address()?.port}`,`localhost:${server.address()?.port}`].includes(req.headers.host)){res.writeHead(403,headers);res.end();return;}
   if(!['GET','HEAD'].includes(req.method)){res.writeHead(405,headers);res.end();return;}
   try{let relative=decodeURIComponent(new URL(req.url,'http://127.0.0.1').pathname).slice(1);const scriptFree=relative==='__hq-noscript'||relative.startsWith('__hq-noscript/');if(scriptFree){relative=relative.slice('__hq-noscript'.length).replace(/^\//,'');headers['Content-Security-Policy']=headers['Content-Security-Policy'].replace("script-src 'self' 'unsafe-inline'","script-src 'none'");}if(path.basename(entry.base)==='dist'&&(relative==='dist'||relative.startsWith('dist/')))relative=relative.slice(4).replace(/^\//,'');relative ||= 'index.html';touch(project);const {file,body:raw}=await readVerified(entry.base,relative);let body=raw;if(scriptFree&&path.extname(file)==='.html')body=Buffer.from(body.toString('utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi,''));res.writeHead(200,{...headers,'Content-Type':TYPES[path.extname(file)]});res.end(req.method==='HEAD'?undefined:body);}catch{res.writeHead(404,headers);res.end('Not found');}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  if(closed){server.close();return null;}
  const url=`http://127.0.0.1:${server.address().port}/`;Object.assign(entry,{server,url});arm(project,entry);active.set(project,entry);db?.logAction('preview.start',{project,kind:'static'},true,'Local static preview prepared');return {url,kind:'static',scriptFreeUrl:url+'__hq-noscript/'};
 }
 return {async ensure(project){const live=active.get(project);if(live){const fresh=await selectBase(live.dir);if(fresh)live.base=fresh;arm(project,live);return {url:live.url,kind:'static',scriptFreeUrl:live.url+'__hq-noscript/'};}if(starting.has(project))return starting.get(project);const pending=start(project);starting.set(project,pending);try{return await pending;}finally{starting.delete(project);}},close(){closed=true;for(const p of active.values()){clearTimeout(p.timer);p.server.close();}active.clear();}};
}
