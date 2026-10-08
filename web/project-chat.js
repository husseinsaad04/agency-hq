import {taskSummary} from './task-summary.js';
const $=id=>document.getElementById(id);
function el(tag,text,cls){const n=document.createElement(tag);if(text)n.textContent=text;if(cls)n.className=cls;return n;}
export function createProjectRequestId(cryptoApi=globalThis.crypto){
 if(typeof cryptoApi?.randomUUID==='function')return cryptoApi.randomUUID();
 // getRandomValues is also available on HTTP inside the private VPN.
 if(typeof cryptoApi?.getRandomValues!=='function')throw Error('This browser cannot create a secure project request. Try reopening HQ in Safari.');
 const bytes=cryptoApi.getRandomValues(new Uint8Array(16));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
 const hex=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
 return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
export function createProjectChatView({nonce,toast,showTask}){
 let busy=false,pendingId=null,projectsStamp='';
 const post=async(url,body)=>{const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','x-ahq-nonce':nonce},body:JSON.stringify({...body,confirmed:true}),signal:AbortSignal.timeout(15000)});const d=await r.json();if(!r.ok)throw Error(d.error||'Project request failed');return d;};
 async function refresh(){try{
  const r=await fetch('/api/project-chat',{signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error();const d=await r.json(),stamp=JSON.stringify(d.projects);
  if(stamp!==projectsStamp){projectsStamp=stamp;const selected=$('chatProject').value;const opts=[['new','New project workspace'],...d.projects.map(p=>[p,p])];$('chatProject').replaceChildren(...opts.map(([value,label])=>{const o=el('option',label);o.value=value;return o;}));if(opts.some(([v])=>v===selected))$('chatProject').value=selected;}
  const focus=document.activeElement?.dataset?.chatAction;
  $('chatProjects').replaceChildren(...d.jobs.slice(0,8).map(j=>{
   const card=el('article',null,'chat-project'),head=el('div',null,'chat-project-heading');head.append(el('strong',j.goal),el('span',j.status.replaceAll('-',' '),`chip status-${j.status}`));card.append(head,el('p',`${j.project} · ${j.note}`,'note'));
   const steps=el('ol',null,'chat-project-steps');steps.setAttribute('aria-label','Company stages');let n=0;for(const s of j.steps){n++;const li=el('li',null,s.state);li.dataset.n=['handed-off','delivered','completed'].includes(s.state)?'✓':String(n);li.append(el('span',s.name));if(s.state!=='pending')li.setAttribute('aria-current',s.state==='handed-off'?'false':'step');steps.append(li);}card.append(steps);
   if(j.evidence){
    const box=el('details',null,'chat-evidence');box.open=['collecting-evidence','active','blocked','paused'].includes(j.status);
    const bad=j.evidence.checks.filter(c=>c.state==='fail').length;box.append(el('summary',`Browser evidence from HQ · ${j.evidence.checks.filter(c=>c.state==='pass').length} passed${bad?` · ${bad} failing`:''}`));
    const list=el('ul',null,'chat-evidence-list');for(const c of j.evidence.checks){const li=el('li',null,`ev-${c.state}`);li.append(el('strong',c.state==='pass'?'Pass':c.state==='fail'?'Fail':'Gap'),el('span',` ${c.name} — ${c.detail}`));list.append(li);}
    const shots=el('div',null,'chat-shots');for(const f of j.evidence.files){const a=el('a',null,'shot');a.href=`/api/project-chat/${j.id}/evidence/${f}`;a.target='_blank';a.rel='noopener noreferrer';const img=el('img');img.src=a.href;img.alt=`Screenshot ${f.replace('.png','').replace('-',' at ')}px`;img.loading='lazy';a.append(img,el('span',f.replace('.png','').replace('-',' · ')+'px'));shots.append(a);}
    box.append(list,shots,el('p','Real headless Chrome run by HQ against the local preview. It supports the tester’s verdict; it does not replace it. Site-specific flows are not covered.','note'));card.append(box);
   }
   if(j.currentTask){const summary=taskSummary(j.currentTask);const readiness=el('div',null,`task-handoff ${summary.handoff.state}`);readiness.setAttribute('aria-label','Handoff readiness');readiness.append(el('strong',summary.handoff.label),el('p',summary.handoff.reason));card.append(readiness);if(['needs-review','delivered','blocked','paused'].includes(j.status))card.append(el('p',summary.outcome,'chat-result'));}
   const actions=el('div',null,'btns');const button=(text,key,fn)=>{const b=el('button',text,'btn');b.type='button';b.dataset.chatAction=j.id+key;b.onclick=fn;return b;};
   if(j.currentTask)actions.append(button(['needs-review','delivered','completed'].includes(j.status)?'Open final result':'Watch current agent','task',()=>showTask(j.currentTask.id)));
   if(['blocked','paused'].includes(j.status))actions.append(button('Continue project','resume',async()=>{try{await post(`/api/project-chat/${j.id}/resume`,{});await refresh();}catch(e){toast(e.message,'err');}}));
   if(!['stopped','completed','delivered'].includes(j.status))actions.append(button('Stop project','stop',async()=>{try{await post(`/api/project-chat/${j.id}/stop`,{});await refresh();}catch(e){toast(e.message,'err');}}));
   card.append(actions);return card;
  }));
  if(focus)[...$('chatProjects').querySelectorAll('button')].find(b=>b.dataset.chatAction===focus)?.focus({preventScroll:true});
 }catch{$('chatConnection').textContent='Project connection unavailable · retrying.';return;} $('chatConnection').textContent='Uses your Codex subscription · works while HQ and your Mac are running.';}
 $('chatForm').onsubmit=async e=>{e.preventDefault();if(busy)return;busy=true;const button=$('chatSend');button.disabled=true;$('chatReply').textContent='Preparing your company project…';
  try{pendingId ||= createProjectRequestId();const d=await post('/api/project-chat',{requestId:pendingId,goal:$('chatGoal').value,project:$('chatProject').value,automatic:$('chatAutomatic').checked});pendingId=null;$('chatReply').textContent=`Started in ${d.job.project}. Research → plan → build → test → final handoff. Watch progress below.`;$('chatGoal').value='';await refresh();toast('Company project started.');}
  catch(e){$('chatReply').textContent=e.message;toast(e.message,'err');}finally{busy=false;button.disabled=false;}
 };
 $('chatGoal').addEventListener('input',()=>{if(!busy)pendingId=null;});$('chatProject').addEventListener('change',()=>{if(!busy)pendingId=null;});
 refresh();setInterval(()=>{if(!$('officeView').hidden)refresh();},3500);
}
