const $=id=>document.getElementById(id);
function el(tag,props={},children=[]) {const n=document.createElement(tag);for(const[k,v]of Object.entries(props)){if(v==null)continue;if(k==='text')n.textContent=v;else if(k==='class')n.className=v;else if(k.startsWith('on'))n.addEventListener(k.slice(2),v);else n.setAttribute(k,v);}for(const c of children)if(c)n.append(c);return n;}
const button=(text,onclick)=>el('button',{class:'btn primary',type:'button',text,onclick});
export function createPaperclipView({assign,showTask}) {
 let data=null,busy=false;
 function roles(){if(!data)return;const q=$('teamSearch').value.toLowerCase(),dept=$('teamDivision').value;const roles=data.roles.filter(r=>(dept==='all'||r.department===dept)&&`${r.name} ${r.slug} ${r.department}`.toLowerCase().includes(q));
  $('teamCount').textContent=`${roles.length} matching roles · ${data.roles.length} imported agents`;
  $('paperclipRoles').replaceChildren(...roles.map(r=>el('article',{class:'card company-role'},[el('p',{class:'sub',text:r.department}),el('h3',{text:r.name}),el('p',{class:'note',text:r.description}),button('Assign from HQ',()=>assign(r.id)),el('a',{class:'btn',href:data.baseUrl,rel:'noreferrer',target:'_blank',text:'Open company in Paperclip ↗'})])));
 }
 async function refresh(){if(busy)return;busy=true;try{const r=await fetch('/api/paperclip',{signal:AbortSignal.timeout(10000)});if(!r.ok)throw new Error('Connection unavailable');const d=await r.json();const initial=!data;data=d;
  $('paperclipStatus').textContent=!d.configured?'Paperclip is not configured.':d.healthy?`Connected · ${d.company.name} · ${d.roles.length} imported agents · synced ${new Date(d.lastSync).toLocaleTimeString()}`:`Paperclip connection needs attention: ${d.error||'connecting…'}. HQ assignments remain available; mirroring retries automatically.`;
  if(initial){const divisions=[...new Set(d.roles.map(r=>r.department))].sort();$('teamDivision').replaceChildren(el('option',{value:'all',text:'All divisions'}),...divisions.map(v=>el('option',{value:v,text:v})));$('paperclipOpen').href=d.baseUrl||'#';roles();}
  $('paperclipAssignments').replaceChildren(...d.links.map(l=>el('article',{class:'brain-note'},[el('h4',{text:l.identifier||'Waiting to create company task'}),el('p',{class:'note',text:`${l.status||'pending'}${l.error?` · Sync error: ${l.error}`:''}`}),el('div',{class:'btns'},[button('Live task & review',()=>showTask(l.taskId)),...(l.issueId?[el('a',{class:'btn',href:`${d.baseUrl}/${d.company.issuePrefix}/issues/${l.identifier||l.issueId}`,target:'_blank',rel:'noreferrer',text:'Open Paperclip task ↗'})]:[])])])));
  if(!d.links.length)$('paperclipAssignments').append(el('p',{class:'note',text:'Assign an imported specialist below. Its assignment, status, and public result will also appear in Paperclip.'}));
 }catch(e){$('paperclipStatus').textContent=e.message;}finally{busy=false;}}
 $('teamSearch').oninput=roles;$('teamDivision').onchange=roles;$('tabPaperclip').addEventListener('click',refresh);refresh();setInterval(()=>{if(!$('paperclipView').hidden)refresh();},5000);
}
