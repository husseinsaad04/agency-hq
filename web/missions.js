import {taskSummary} from './task-summary.js';
const $ = id => document.getElementById(id);
const ACTIVE = ['queued', 'running', 'cancelling'];
export const stateLabel=t=>t.supersededBy?'EARLIER ATTEMPT':t.review==='changes-requested'?'CHANGES REQUESTED':t.reviewOptional&&t.status==='review'?'DELIVERED':t.status.replaceAll('-',' ').toUpperCase();
export const matchesTaskFilter=(t,f)=>f==='all'||(f==='active'?ACTIVE.includes(t.status):f==='failed'?['failed','interrupted','cancelled'].includes(t.status):f==='review'?t.status==='review'&&!t.reviewOptional:f==='completed'?t.status==='completed'||t.reviewOptional:t.status===f);
function node(tag, props = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k,v] of Object.entries(props)) {
    if (v == null) continue;
    if (k === 'text') n.textContent = v;
    else if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2),v);
    else n.setAttribute(k,v);
  }
  for (const c of children) if (c != null) n.append(c);
  return n;
}
const button = (text, onclick, cls = '') => node('button', { text, onclick, type:'button', class:`btn ${cls}` });
const date = t => t ? new Date(t).toLocaleString() : '—';
export function createMissions({ nonce, toast, ask, showOffice }) {
  let catalog = null, tasks = [], selected = null, previous = '', loading = false;
  const post = async (url, body) => {
    const r = await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','x-ahq-nonce':nonce},body:JSON.stringify({...body,confirmed:true}),signal:AbortSignal.timeout(15000)});
    const data = await r.json();
    if (!r.ok || data.ok === false) throw new Error(data.message || data.error || `HTTP ${r.status}`);
    return data;
  };
  const action = async (id, op, body = {}) => {
    if (['cancel','retry'].includes(op) && !(await ask(op === 'cancel' ? 'Stop this task?' : 'Retry this task?', op === 'cancel' ? 'Stops the running agent. Files it already changed stay in the project.' : 'Starts a new run with the original instructions and access mode. Uses your selected provider account.', op === 'cancel' ? 'Stop task' : 'Run again'))) return;
    try { const r = await post(`/api/tasks/${id}/${op}`,body); selected = r.task.id; previous=''; await refresh(); toast(op === 'review' ? 'Review saved.' : `${op === 'retry' ? 'New task queued' : 'Stopping task'}…`); } catch(e) {toast(e.message,'err');}
  };
  function inbox() {
    const filter = $('taskFilter').value;
    const visible = tasks.filter(t => matchesTaskFilter(t,filter));
    const focusedFilter=document.activeElement?.dataset?.taskFilter;
    $('taskSummary').replaceChildren(...[['active','In progress',tasks.filter(t=>ACTIVE.includes(t.status)).length],['review','Needs review',tasks.filter(t=>t.status==='review'&&!t.reviewOptional).length],['completed','Completed',tasks.filter(t=>t.status==='completed'||t.reviewOptional).length]].map(([key,label,num])=>node('button',{type:'button',class:'chip task-summary-filter',text:`${label} · ${num}`,'data-task-filter':key,'aria-pressed':String(filter===key),'aria-controls':'taskInbox',onclick:()=>filterTasks(key)})));
    if(focusedFilter)[...$('taskSummary').children].find(b=>b.dataset.taskFilter===focusedFilter)?.focus({preventScroll:true});
    // Keep focus intact when background polling rebuilds the inbox.
    const focused = document.activeElement?.dataset?.task;
    $('taskInbox').replaceChildren(...(visible.length ? visible.map(t => node('button',{ type:'button',class:`task-card ${t.status}${selected===t.id?' selected':''}`,'data-task':t.id,'aria-pressed':String(selected===t.id),onclick:()=>{selected=t.id;previous='';inbox();detail();if(ACTIVE.includes(t.status))showOffice(t);}},[
      node('span',{class:'task-state',text:stateLabel(t)}),node('strong',{text:t.title}),node('span',{class:'note',text:`${t.skillName} · ${t.runtime} · ${t.project}`}),node('span',{class:'task-activity',text:t.activity}),node('time',{text:date(t.createdAt)})
    ])) : [node('p',{class:'note',text: tasks.length ? 'No tasks match this filter.' : 'No tasks yet. Choose a specialist below or click New task.'})]));
    if (focused) [...$('taskInbox').children].find(n=>n.dataset.task===focused)?.focus({preventScroll:true});
    const count = tasks.filter(t=>t.status==='review'&&!t.reviewOptional).length;
    $('tabTasks').textContent = count ? `Assignments · ${count}` : 'Assignments';
  }
  async function detail() {
    if (!selected) { $('taskDetail').replaceChildren(node('h3',{text:'Your agents, on assignment'}),node('p',{class:'note',text:'Select a task to see its instructions, current activity, results, and tool timeline.'}));return; }
    const id = selected;
    try {
      const r=await fetch(`/api/tasks/${id}`,{signal:AbortSignal.timeout(10000)});if(!r.ok) throw new Error('Task unavailable');const t=await r.json();
      if(selected!==id) return;
      const stamp=JSON.stringify(t);if(stamp===previous)return;previous=stamp;
    const controls=[button('Open agent’s office',()=>showOffice(t),'primary')];
      if(t.preview?.kind==='static'&&/^http:\/\/127\.0\.0\.1:\d+\/$/.test(t.preview.url))controls.push(button('Open website preview on Mac',async()=>{
        // Re-ensures the fixed static preview, so an expired localhost link never needs a rebuild.
        const win=window.open('about:blank','_blank');if(win)win.opener=null;
        try{const d=await post(`/api/tasks/${t.id}/preview`,{});if(!/^http:\/\/127\.0\.0\.1:\d+\/$/.test(d.preview?.url))throw new Error('Preview unavailable');if(win)win.location=d.preview.url;else location.href=d.preview.url;}
        catch(e){win?.close();toast(e.message,'err');}
      }));
      if(t.supersededBy)controls.push(button('View current assignment',()=>{selected=t.currentId||t.supersededBy;$('taskFilter').value='all';previous='';inbox();detail();}));
      if(ACTIVE.includes(t.status)) controls.push(button(t.status==='cancelling'?'Stopping…':'Stop task',()=>action(t.id,'cancel'),'danger'));
      if(['completed','failed','cancelled','interrupted'].includes(t.status))controls.push(button('Run again',()=>action(t.id,'retry')));
      if(t.status==='review')controls.push(button('Approve result',()=>action(t.id,'review',{verdict:'approved'}),'good'),button('Needs changes',()=>action(t.id,'review',{verdict:'changes-requested'}),'bad'));
      if(t.status==='completed'&&t.review==='changes-requested')controls.push(button('Create follow-up',()=>compose(t.skill,t)));
      if(t.status==='completed'&&t.review==='approved')controls.push(button('Save to shared brain',async()=>{try{await post('/api/brain/capture',{taskId:t.id});toast('Approved result saved to this project’s shared brain.');}catch(e){toast(e.message,'err');}}));
      controls.push(node('a',{class:'btn',href:`/api/tasks/${t.id}/export`,text:'Download report',download:'agency-task.txt'}));
      const box=$('taskDetail');
      const timeline=box.querySelector('.task-timeline');const scroll=timeline?.scrollTop;const atEnd=timeline?timeline.scrollHeight-timeline.clientHeight-timeline.scrollTop<30:true;
      const instructionsOpen=box.querySelector('.task-instructions')?.open;
      const expanded=Object.fromEntries([...box.querySelectorAll('details[data-section]')].map(x=>[x.dataset.section,x.open]));
      const focused=document.activeElement?.closest('#taskDetail')?document.activeElement.textContent:null;
      const instructions=node('details',{class:'task-instructions'},[node('summary',{text:'Task instructions'}),node('pre',{text:t.instructions})]);if(instructionsOpen)instructions.open=true;
      const summary=taskSummary(t),overview=node('section',{class:'task-result-summary','aria-label':'Result summary'},[node('div',{class:`task-handoff ${summary.handoff.state}`,'aria-label':'Handoff readiness'},[node('strong',{text:summary.handoff.label}),node('p',{text:summary.handoff.reason})]),node('h4',{text:summary.label}),node('p',{text:summary.outcome})]);
      if(summary.checks.length)overview.append(node('h5',{text:'Checks'}),node('ul',{},summary.checks.map(text=>node('li',{text}))));
      if(summary.gaps?.length)overview.append(node('h5',{text:'Optional gaps (not blockers)'}),node('ul',{},summary.gaps.map(text=>node('li',{text}))));
      if(summary.attention.length)overview.append(node('h5',{text:'Needs attention / next step'}),node('ul',{},summary.attention.map(text=>node('li',{text}))));
      const full=node('details',{'data-section':'report'},[node('summary',{text:'Full report & public updates'}),node('pre',{class:'task-result',text:t.result||'No public reply yet.'})]);full.open=expanded.report===true;
      const activity=node('details',{'data-section':'activity'},[node('summary',{text:`Activity timeline · ${t.events.length} recent events`}),node('p',{class:'note',text:'Actual tool events and public replies. Private reasoning and raw tool results are not shown.'}),node('ol',{class:'task-timeline'},t.events.map(e=>node('li',{class:e.kind},[node('time',{text:new Date(e.ts).toLocaleTimeString()}),node('b',{text:e.kind}),node('span',{text:e.text})])))]);activity.open=expanded.activity===true;
      const info=node('details',{'data-section':'info'},[node('summary',{text:'Assignment details'}),node('p',{class:'note',text:`${t.skillName} / ${t.runtime} · ${t.project} · ${t.mode==='workspace-write'?'Can edit project files':'Read only'} · Started ${date(t.startedAt)}`}),node('p',{class:'note',text:`Shared knowledge: ${t.knowledgeIds?.length||0} project notes. Budget: ${t.budgetMinutes||20} minutes.`}),...(t.usage?[node('p',{class:'note',text:`Provider tokens: ${t.usage.inputTokens??'—'} in / ${t.usage.outputTokens??'—'} out`})]:[]),instructions]);info.open=expanded.info===true;
      box.replaceChildren(node('div',{class:'task-detail-head'},[node('h3',{text:t.title}),node('span',{class:`task-state ${t.status}`,text:stateLabel(t)})]),overview,node('div',{class:'btns'},controls),full,activity,info);
      const next=box.querySelector('.task-timeline');if(atEnd)next.scrollTop=next.scrollHeight;else next.scrollTop=scroll||0;
      if(focused)[...box.querySelectorAll('button,a')].find(n=>n.textContent===focused)?.focus({preventScroll:true});
    } catch(e){toast(`Could not load task: ${e.message}`,'err');}
  }
  function toolkit(){
    const kit=catalog.codexToolkit;if(!kit)return;
    $('codexToolkitBody').replaceChildren(node('p',{class:'note',text:kit.billing}),node('div',{class:'toolkit-grid'},kit.capabilities.map(c=>node('article',{},[node('strong',{text:c.name}),node('p',{class:'note',text:c.detail})]))),node('p',{class:'note',text:`Registered app tools: ${(kit.registeredApps||[]).join(' · ')}`}),node('p',{class:'micro',text:kit.inventoryNote}),node('p',{class:'note',text:kit.limits}));
  }
  function skillLibrary() {
    $('skillLibrary').replaceChildren(...catalog.skills.map(s=>node('article',{class:'card'},[node('div',{class:'name',text:`${s.icon} ${s.name}`}),node('p',{class:'note',text:s.description}),node('details',{},[node('summary',{text:'Skill instructions'}),node('p',{class:'note',text:s.prompt})]),button('Assign a task',()=>compose(s.id))])));
  }
  async function refresh() {
    if(loading)return;loading=true;
    try {
      if(!catalog){const r=await fetch('/api/task-catalog');if(!r.ok)throw new Error('Task runner unavailable');catalog=await r.json();skillLibrary();toolkit();}
      const r=await fetch('/api/tasks',{signal:AbortSignal.timeout(10000)});if(!r.ok)throw new Error('Task inbox unavailable');tasks=(await r.json()).tasks;
      if(!selected&&tasks.length)selected=tasks[0].id;
      inbox();if(!$('tasksView').hidden)await detail();
    } catch(e){if(!$('tasksView').hidden)$('taskSummary').textContent=`${e.message}; retrying…`;}
    finally{loading=false;}
  }
  function compose(skillId='researcher', original=null, defaults={}) {
    if(!catalog)return toast('Task catalog is still connecting. Try again in a moment.','err');
    const form=$('dlgForm'),dlg=$('dlg');
    $('dlgTitle').textContent=original?'Create a follow-up task':'Send an agent on assignment';
    $('dlgNote').textContent='Uses your existing provider login. HQ keeps this task’s instructions, public replies, and activity locally so you can return to it.';
    $('dlgConfirm').textContent='Read-only tasks inspect and report. Project-write tasks can change files in the selected project. Review results here; approval records your verdict and does not deploy anything.';
    const field=(name,label,input)=>node('div',{class:'field'},[node('label',{for:name,text:label}),input]);
    const options=(id,items)=>node('select',{id,name:id,required:''},items.map(([v,label])=>node('option',{value:v,text:label})));
    const skill=options('taskSkill',catalog.skills.map(s=>[s.id,s.name]));skill.value=skillId;
    const runtime=options('taskRuntime',catalog.runtimes.map(r=>[r.id,r.name]));runtime.value=original?.runtime||'codex';
    const project=options('taskProject', [['','Choose a project…'],...catalog.projects.map(p=>[p,p])]);project.value=original?.project||defaults.project||'';
    const budget=options('taskBudget',[['5','5 minutes'],['10','10 minutes'],['20','20 minutes'],['30','30 minutes']]);budget.value=String(original?.budgetMinutes||20);
    const mode=options('taskMode',[['read-only','Read only — research and inspect']]);
    const toolNote=node('p',{class:'assignment-tools note',id:'assignmentToolNote'});
    const sync=()=>{toolNote.textContent=runtime.value==='codex'?'Uses your Codex subscription: live web search, project work, and existing Codex tools/plugins. Your plan limits still apply. API-key fallback is disabled.':catalog.runtimes.find(r=>r.id===runtime.value)?.description;const r=catalog.runtimes.find(r=>r.id===runtime.value);mode.replaceChildren(...r.modes.map(m=>node('option',{value:m,text:m==='read-only'?'Read only — research and inspect':'Project write — implement and test'})));};runtime.addEventListener('change',sync);sync();
    const title=node('input',{id:'taskTitle',name:'title',required:'',maxlength:'100',placeholder:'A clear task name'});title.value=original?`Follow-up: ${original.title}`.slice(0,100):'';
    const prompt=node('textarea',{id:'taskInstructions',required:'',maxlength:'6000',placeholder:catalog.skills.find(s=>s.id===skillId)?.example||'Describe the outcome you want and what a good result looks like.'});if(defaults.instructions)prompt.value=defaults.instructions; if(original)prompt.value=`Previous task: ${original.title}\n\n${original.instructions}\n\nChanges needed:\n`;
    $('dlgFields').replaceChildren(field('taskTitle','Task name',title),field('taskSkill','Specialist',skill),field('taskRuntime','Run with',runtime),toolNote,field('taskProject','Project',project),field('taskMode','Access',mode),field('taskBudget','Time budget',budget),field('taskInstructions','Assignment',prompt));
    $('dlgOk').textContent='Send task';$('dlgCancel').onclick=()=>dlg.close();
    form.onsubmit=async e=>{e.preventDefault();const btn=$('dlgOk');btn.disabled=true;
      try{const r=await post('/api/tasks',{title:title.value,instructions:prompt.value,skill:skill.value,runtime:runtime.value,project:project.value,mode:mode.value,budgetMinutes:Number(budget.value)});selected=r.task.id;previous='';dlg.close();toast('Task queued. Watch its progress in Tasks.');await refresh();}
      catch(err){toast(err.message,'err');}finally{btn.disabled=false;}};
    dlg.showModal();title.focus();
  }
  $('newTask').onclick=()=>compose();
  $('newSkill').onclick=()=>{
    const dlg=$('dlg');$('dlgTitle').textContent='Create a reusable specialist skill';$('dlgNote').textContent='These instructions guide tasks you assign to this specialist.';$('dlgConfirm').textContent='';
    const name=node('input',{id:'skillName',maxlength:'60',required:''}),prompt=node('textarea',{id:'skillPrompt',maxlength:'4000',required:''});
    $('dlgFields').replaceChildren(node('label',{for:'skillName',text:'Specialist name'}),name,node('label',{for:'skillPrompt',text:'Reusable instructions'}),prompt);$('dlgOk').textContent='Save skill';$('dlgCancel').onclick=()=>dlg.close();
    $('dlgForm').onsubmit=async e=>{e.preventDefault();$('dlgOk').disabled=true;try{await post('/api/skills',{name:name.value,prompt:prompt.value});catalog=null;dlg.close();await refresh();toast('Skill saved. It is ready for assignments.');}catch(err){toast(err.message,'err');}finally{$('dlgOk').disabled=false;}};dlg.showModal();name.focus();
  };
  function filterTasks(value){
    $('taskFilter').value=value;
    const visible=tasks.filter(t=>matchesTaskFilter(t,value));
    if(!visible.some(t=>t.id===selected))selected=visible[0]?.id||null;
    previous='';inbox();detail();
  }
  $('taskFilter').onchange=()=>filterTasks($('taskFilter').value);
  $('tabTasks').addEventListener('click',()=>{previous='';refresh();});
  refresh();setInterval(()=>{if(!$('tasksView').hidden)refresh();},2500);
  return { assign(id, defaults={}) { compose(id, null, defaults); }, showReviews() { $('taskFilter').value='review'; selected=tasks.find(t=>t.status==='review'&&!t.reviewOptional)?.id||null; previous=''; inbox(); detail(); }, showTask(id) { $('taskFilter').value='all'; selected = id; previous = ''; inbox(); detail(); } };
}
