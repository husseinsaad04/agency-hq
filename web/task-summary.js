import {decision,isMarkerLine,optionalGaps} from './protocol.js';
// Extract short excerpts from public replies only. Never infer completion from activity.
const plain=text=>String(text||'').replace(/\[([^\]]+)\]\([^)]*\)/g,'$1').replace(/\*\*|`/g,'').trim();
const excerpt=(text,max=360)=>{text=plain(text).replace(/\s+/g,' ');return text.length>max?text.slice(0,max-1).trimEnd()+'…':text;};
const protocol=line=>isMarkerLine(line);
function handoff(task,source){
 if(['queued','running','cancelling'].includes(task.status))return {state:'pending',label:'Handoff ready: Not yet',reason:'The agent is still working.'};
 if(['failed','interrupted','cancelled'].includes(task.status))return {state:'blocked',label:'Handoff ready: No',reason:'This run stopped. Review its partial work before continuing.'};
 const ready=decision(source,'HANDOFF_READY'),checks=decision(source,'CHECKS_PASSED');
 const failedCheck=checks==='NO'||checks==='CONFLICT';
 if(ready==='NO'||ready==='CONFLICT'||failedCheck||['rejected','changes-requested'].includes(task.review))return {state:'blocked',label:'Handoff ready: No',reason:task.review==='changes-requested'?'You requested changes on this result.':failedCheck?'Required checks are blocked or have not passed.':'The report or review flags work that still needs attention.'};
 if(ready==='YES')return {state:'ready',label:'Handoff ready: Yes',reason:'The agent reports this assignment is ready. Approval does not deploy or post.'};
 return {state:'unconfirmed',label:'Handoff ready: Not confirmed',reason:'This report did not include an explicit readiness decision.'};
}
export function taskSummary(task){
 const messages=(task.events||[]).filter(e=>e.kind==='message'&&e.text?.trim());
 const source=messages.at(-1)?.text||task.result||'';
 const displaySource=source.split('\n').filter(line=>!protocol(line)).join('\n');
 const lines=displaySource.split('\n').map(plain).filter(Boolean);
 const blocks=displaySource.split(/\n\s*\n/).map(plain).filter(Boolean);
 const sections={};let section=null;
 for(const line of displaySource.split('\n')){
  const heading=plain(line).replace(/^#+\s*/,'').replace(/:$/,'').toLowerCase();
  if(['outcome','checks','next step','details'].includes(heading)){section=heading;sections[section]=[];continue;}
  if(section&&line.trim())sections[section].push(plain(line).replace(/^[-*]\s*/,''));
 }
 const active=['queued','running','cancelling'].includes(task.status);
 const stopped=['failed','interrupted','cancelled'].includes(task.status);
 const outcome=stopped?`${task.activity||'Run stopped before completion.'} ${excerpt(blocks[0]||'',260)}`:excerpt(sections.outcome?.join(' ')||blocks[0]||(active?'Waiting for the agent’s first public update.':'No public result was returned.'));
 const checks=(sections.checks||lines.filter(line=>/\b(?:\d+\s*(?:\/\s*\d+)?\s*(?:tests?\s*)?(?:passed|failed|executed)|validation:|checks:)/i.test(line))).slice(0,2).map(line=>excerpt(line.replace(/^[-*]\s*/,''),240));
 const attention=(sections['next step']||blocks.filter(block=>block!==blocks[0]&&/\b(?:require(?:s|d)?|must|unverified|blocking|remain(?:s)? held|should remain|before (?:approv\w*|deploy\w*|post\w*)|no (?:deployment|post)|not establish production)\b/i.test(block))).slice(0,2).map(block=>excerpt(block,240));
 const gaps=optionalGaps(source).slice(0,3).map(g=>excerpt(g,240));
 return {gaps,label:active?'Latest update':stopped?'Partial result':'Result summary',outcome:excerpt(outcome,480),checks,attention,handoff:handoff(task,source)};
}
