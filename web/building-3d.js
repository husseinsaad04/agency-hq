// Original Saad Headquarters scene. All assets are local; task state stays in HQ.
import * as T from './vendor/three.module.js';
import {OrbitControls} from './vendor/OrbitControls.js';
import {floorPlan,assignmentFor,residentState,workstationText} from './spatial-logic.js';
const COLORS={available:0x529ba9,running:0x66f6ce,queued:0x8bacff,cancelling:0xf9a678,review:0xffcd7d,failed:0xff708a,interrupted:0xff708a,'changes-requested':0xff9f78};
const $=id=>document.getElementById(id);
export function createBuilding3D(host,{onAgent,onFloor,onMonitor,identity}) {
 const renderer=new T.WebGLRenderer({antialias:true,alpha:false,powerPreference:'high-performance'});
 renderer.setPixelRatio(Math.min(Math.max(devicePixelRatio,1.5),2.5));renderer.shadowMap.enabled=true;renderer.shadowMap.type=T.PCFShadowMap;renderer.setClearColor(0x071019);renderer.outputColorSpace=T.SRGBColorSpace;renderer.toneMapping=T.ACESFilmicToneMapping;renderer.toneMappingExposure=1.35;
 renderer.domElement.setAttribute('aria-label','Interactive Saad Headquarters 3D model. Drag to orbit, scroll to zoom; use department and resident buttons for keyboard access.');renderer.domElement.setAttribute('tabindex','0');host.prepend(renderer.domElement);
 const scene=new T.Scene();scene.fog=new T.FogExp2(0x071019,.0015);
 const camera=new T.PerspectiveCamera(43,1,.1,700),controls=new OrbitControls(camera,renderer.domElement);
 controls.enableDamping=true;controls.dampingFactor=.1;controls.minDistance=4;controls.maxDistance=230;controls.maxPolarAngle=Math.PI*.49;controls.target.set(0,22,0);
 scene.add(new T.HemisphereLight(0xbce9f5,0x172231,1.4));const sun=new T.DirectionalLight(0xc9e9ff,3);sun.position.set(-35,70,40);sun.castShadow=true;sun.shadow.mapSize.set(2048,2048);Object.assign(sun.shadow.camera,{left:-40,right:40,top:50,bottom:-40,near:1,far:150});sun.shadow.radius=3;sun.shadow.bias=-.0003;sun.shadow.normalBias=.03;scene.add(sun);const warm=new T.DirectionalLight(0xffd2a6,1.5);warm.position.set(40,25,-20);scene.add(warm);
 const cube=new T.BoxGeometry(1,1,1),sphere=new T.SphereGeometry(1,20,14),cylinder=new T.CylinderGeometry(1,1,1,16),hair=new T.SphereGeometry(1,10,6,0,Math.PI*2,0,Math.PI/2);
 const materials={metal:new T.MeshStandardMaterial({color:0x183342,roughness:.43,metalness:.6}),desk:new T.MeshStandardMaterial({color:0xa98258,roughness:.55,metalness:.2}),chair:new T.MeshStandardMaterial({color:0x152536,roughness:.6}),glass:new T.MeshStandardMaterial({color:0x79b5c7,transparent:true,opacity:.14,roughness:.15,metalness:.1,depthWrite:false}),floor:new T.MeshStandardMaterial({color:0x77858a,roughness:.7,metalness:.15}),skin:new T.MeshStandardMaterial({color:0xd5a584,roughness:.75}),hair:new T.MeshStandardMaterial({color:0x1b222c,roughness:.8}),plant:new T.MeshStandardMaterial({color:0x428869,roughness:.75}),pot:new T.MeshStandardMaterial({color:0x7b8990,roughness:.7}),light:new T.MeshBasicMaterial({color:0x63e7e0,toneMapped:false}),warm:new T.MeshBasicMaterial({color:0xffcf93,toneMapped:false})};
 // Original procedural surface textures: no remote assets or additional libraries.
 function surface(kind){const c=document.createElement('canvas');c.width=c.height=512;const ctx=c.getContext('2d');ctx.fillStyle=kind==='wood'?'#aa8056':'#76888e';ctx.fillRect(0,0,512,512);
  for(let y=0;y<512;y+=kind==='wood'?64:128){for(let x=0;x<512;x+=kind==='wood'?256:128){ctx.strokeStyle=kind==='wood'?'#694c35':'#52686f';ctx.lineWidth=2;ctx.strokeRect(x,y,kind==='wood'?256:128,kind==='wood'?64:128);}}
  if(kind==='wood')for(let i=0;i<180;i++){ctx.strokeStyle=i%2?'#bb93683b':'#64482b30';ctx.beginPath();ctx.moveTo(0,i*3);ctx.lineTo(512,i*3+(i%5));ctx.stroke();}
  const tx=new T.CanvasTexture(c);tx.colorSpace=T.SRGBColorSpace;tx.wrapS=tx.wrapT=T.RepeatWrapping;tx.repeat.set(kind==='wood'?2:8,kind==='wood'?1:8);tx.anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy());return tx;}
 materials.floor.map=surface('tile');materials.desk.map=surface('wood');
 Object.assign(materials,{rug:new T.MeshStandardMaterial({color:0x284958,roughness:.98}),white:new T.MeshStandardMaterial({color:0xc1cbd0,roughness:.6}),sofa:new T.MeshStandardMaterial({color:0x526978,roughness:.93}),book:new T.MeshStandardMaterial({color:0xb18f63,roughness:.8}),black:new T.MeshStandardMaterial({color:0x0d1920,roughness:.6})});
 const departmentMaterials=[0x438f9e,0x7183c0,0x9d6d9b,0xb59861,0x5a9e90,0x467d9b].map(color=>new T.MeshStandardMaterial({color,roughness:.85}));
 const suits=[0x2e5369,0x536884,0x387364,0x785975,0x577a8e,0x92724f].map(color=>new T.MeshStandardMaterial({color,roughness:.6}));
 let roles=[],tasks=[],plan=null,floors=[],officeMap=new Map(),monitors=new Map(),labels=[],mode='tower',focused=null,selected=null,selectedTaskId=null,paused=false,autorotate=false,theme='night',visible=true,flight=null,frame=0,lastRender=0;
 const raycaster=new T.Raycaster(),pointer=new T.Vector2(),dummy=new T.Object3D(),picks=[],animated=[];
 const world=new T.Group();scene.add(world);
 const floorLabels=document.createElement('div');floorLabels.className='spatial-labels';host.append(floorLabels);
 const tooltip=document.createElement('div');tooltip.className='scene-tooltip';tooltip.hidden=true;host.append(tooltip);
 const highlight=new T.Mesh(new T.TorusGeometry(.55,.035,5,32),new T.MeshBasicMaterial({color:0xa7ffeb,depthTest:false}));highlight.rotation.x=-Math.PI/2;highlight.visible=false;scene.add(highlight);
 function mesh(g,mat,parent,pos,scale,data={}){const m=new T.Mesh(g,mat);m.position.set(...pos);m.scale.set(...scale);m.userData=data;m.castShadow=mat!==materials.glass&&!data.monitor;m.receiveShadow=true;parent.add(m);if(data.roleId||data.floor)picks.push(m);return m;}
 function textSprite(text,color='#d5fbf3',size=1.4){const c=document.createElement('canvas');c.width=768;c.height=96;const ctx=c.getContext('2d');ctx.fillStyle='#102837';ctx.fillRect(0,0,768,96);ctx.strokeStyle='#4a7b86';ctx.strokeRect(1,1,766,94);ctx.fillStyle=color;ctx.font='500 37px system-ui';ctx.fillText(text,24,62);const tex=new T.CanvasTexture(c);tex.colorSpace=T.SRGBColorSpace;const s=new T.Sprite(new T.SpriteMaterial({map:tex,depthTest:true}));s.scale.set(size*8,size,1);s.userData.labelText=text;s.userData.labelContext=ctx;s.userData.labelColor=color;return s;}
 function setScreen(m,role,task){const lines=workstationText(role,task),key=lines.join('|');if(m.userData.screenKey===key)return;m.userData.screenKey=key;const ctx=m.userData.ctx;ctx.fillStyle='#04151d';ctx.save();ctx.scale(2,2);ctx.fillRect(0,0,384,216);ctx.fillStyle=task?.status==='running'?'#7ef9d7':'#92c6d5';ctx.font='bold 22px monospace';ctx.fillText(lines[1],16,30);ctx.fillStyle='#def4f2';ctx.font='17px monospace';for(let i=0;i<3;i++)ctx.fillText(lines[i===0?0:i+1].slice(0,34),16,65+i*36);ctx.fillStyle='#3c7082';ctx.fillRect(16,187,350,2);ctx.restore();m.material.map.needsUpdate=true;}
 function clearWorld(){world.traverse(x=>{if(x.material?.map&&x.material!==materials.floor&&x.material!==materials.desk){x.material.map.dispose();x.material.dispose();}if(x.isInstancedMesh)x.dispose();});world.clear();floors=[];picks.length=0;animated.length=0;officeMap.clear();monitors.clear();floorLabels.replaceChildren();labels=[];}
 function build(){clearWorld();plan=floorPlan(roles);
 mesh(cube,materials.metal,world,[0,-.8,0],[plan.width+9,1.3,plan.depth+9]);
 mesh(cube,materials.light,world,[0,-.08,plan.depth/2+3],[plan.width+7,.07,.15]);mesh(cube,materials.light,world,[-plan.width/2-3,-.08,0],[.15,.07,plan.depth+6]);
 mesh(cylinder,materials.metal,world,[0,-1.7,0],[45,.25,45]);
 // Quiet city silhouettes and landscaped podium provide architectural context.
 for(let i=0;i<18;i++){const x=-85+i*10,z=-65-(i%3)*8,h=5+(i*7%22);const block=mesh(cube,materials.metal,world,[x,h/2-1.5,z],[4+(i%3)*2,h,4+(i%2)*3]);for(let j=0;j<Math.min(8,Math.floor(h/2));j++)mesh(cube,materials.warm,world,[x,h*.15+j*2,z+2.05+(i%2)*1.5],[1.8,.12,.04]);}
 const logo=textSprite('SAAD HEADQUARTERS','#8ff1e5',2.1);logo.position.set(0,2,plan.depth/2+4);world.add(logo);logo.userData.decorativeLabel=true;
 // A lit central elevator shaft anchors the architecture; it is visual scenery.
 const height=(plan.floors.length-1)*3.7+3;
 mesh(cube,materials.glass,world,[-plan.width/2+1,height/2,-plan.depth/2+1],[2,height,2],{spine:true});mesh(cube,materials.light,world,[-plan.width/2+2.1,height/2,-plan.depth/2+1],[.12,height,.12],{spine:true});
 mesh(cube,materials.glass,world,[0,height/2,plan.depth/2+.5],[1.7,height,1.7],{spine:true});
 for(const x of [-.9,.9])mesh(cube,materials.light,world,[x,height/2,plan.depth/2+1.4],[.09,height,.09],{spine:true});
 for(const x of [-plan.width/2,plan.width/2])mesh(cube,materials.metal,world,[x,height/2,-plan.depth/2],[.35,height,.35],{spine:true});
 for(const f of plan.floors){const group=new T.Group();world.add(group);const accent=departmentMaterials[f.index%departmentMaterials.length];const rec={...f,group,batches:new Map()};floors.push(rec);
 const data={floor:f.name};mesh(cube,materials.floor,group,[0,-.12,0],[plan.width,.25,f.depth],data);
 mesh(cube,materials.metal,group,[0,0,-f.depth/2],[plan.width,.2,.35]);mesh(cube,materials.light,group,[0,.04,f.depth/2],[plan.width,.07,.12],data);mesh(cube,materials.light,group,[plan.width/2,.04,0],[.12,.07,f.depth],data);
 mesh(cube,materials.glass,group,[0,.5,f.depth/2],[plan.width,.9,.07]);mesh(cube,materials.metal,group,[-plan.width/2,1.35,f.depth/2],[.25,2.7,.25]);mesh(cube,materials.metal,group,[plan.width/2,1.35,f.depth/2],[.25,2.7,.25]);
 mesh(cube,materials.glass,group,[0,1.2,-f.depth/2],[plan.width,2.4,.12]);mesh(cube,materials.glass,group,[-plan.width/2,1.2,0],[.12,2.4,f.depth]);
 mesh(cube,materials.warm,group,[0,2.7,f.depth/2-.4],[plan.width-.8,.06,.12],{ceiling:true});
 for(const x of [-plan.width/2,plan.width/2])mesh(cube,materials.light,group,[x,1.3,f.depth/2],[.07,2.6,.07]);
 const title=textSprite(`${String(f.index+1).padStart(2,'0')} / ${f.name.toUpperCase()}`,'#bdece8',1.05);title.position.set(plan.width/2-5,.5,f.depth/2+.25);group.add(title);rec.title=title;
 const label=document.createElement('button');label.type='button';label.className='scene-floor-label';label.textContent=`${String(f.index+1).padStart(2,'0')} ${f.name}`;label.onclick=()=>onFloor(f.name);floorLabels.append(label);labels.push({element:label,floor:rec});
 function batch(geo,mat,pos,scale,id=null,animate=false){const key=`${geo.uuid}:${mat.uuid}`;if(!rec.batches.has(key))rec.batches.set(key,{geo,mat,items:[]});const item={pos,scale,id,animate};rec.batches.get(key).items.push(item);return item;}
 // Shared rear strip: glazed conference suite, hospitality lounge and coffee bar.
 const rear=-f.depth/2+4.1;
 function furnish(pos,scale,mat=materials.desk,geo=cube){return batch(geo,mat,pos,scale);}
 function seat(x,z){for(const dx of [-.2,.2])for(const dz of [-.2,.2])furnish([x+dx,.2,z+dz],[.04,.4,.04],materials.metal);furnish([x,.45,z],[.65,.15,.65],materials.chair);furnish([x,.85,z+.27],[.65,.7,.12],materials.chair);furnish([x,.23,z],[.09,.45,.09],materials.metal,cylinder);}
 function plant(x,z){furnish([x,.3,z],[.32,.6,.32],materials.pot,cylinder);furnish([x,.95,z],[.48,.8,.48],materials.plant,sphere);}
 function sofa(x,z,w=3.2){furnish([x,.38,z],[w,.65,1.1],materials.sofa);furnish([x,.85,z-.5],[w,.7,.2],materials.sofa);for(const side of [-1,1])furnish([x+side*(w/2-.12),.65,z],[.24,.6,1.1],materials.sofa);for(let j=0;j<3;j++)furnish([x+(j-1)*.85,.74,z],[.78,.12,.8],accent);}
 furnish([-13,.02,rear],[12,.045,7.2],materials.rug);furnish([-13,.85,rear],[7.8,.16,2.8]);furnish([-13,.4,rear],[.5,.8,1.6],materials.metal);
 for(let j=0;j<4;j++){seat(-16+j*2,rear+2);seat(-16+j*2,rear-2);}
 for(const x of [-19,-7]){furnish([x,1.1,rear],[.09,2.2,7.2],materials.glass);furnish([x,1.1,rear-3.6],[.12,2.2,.12],materials.metal);}
 furnish([-13,1.1,rear-3.6],[12,2.2,.08],materials.glass);furnish([-13,1.3,rear-3.5],[5.4,1.3,.07],materials.black);furnish([-13,1.3,rear-3.44],[4.9,.9,.03],accent);
 furnish([0,.02,rear],[11,.045,7.2],materials.rug);sofa(-2.4,rear-1.5,4.8);sofa(2.6,rear+1.6,3.5);furnish([0,.42,rear],[2.7,.13,1.5]);furnish([0,.2,rear],[.12,.4,.12],materials.metal,cylinder);plant(-5,rear+2.5);plant(5,rear-2.5);
 furnish([13,.02,rear],[11,.045,7.2],materials.rug);furnish([14,.55,rear-2],[8,1.1,1.1],materials.white);furnish([14,1.15,rear-2],[8,.12,1.3]);furnish([12,1.4,rear-2],[.6,.6,.55],materials.black);furnish([16,1.2,rear-2],[.65,.1,.5],materials.metal);furnish([13,.9,rear+1],[6,.16,1.5]);for(let j=0;j<3;j++){seat(11+j*2,rear+2.4);furnish([11+j*2,1.04,rear+1],[.09,.2,.09],materials.white,cylinder);}plant(18,rear+2);
 for(const [caption,x] of [['MEETING SUITE',-13],['TEAM LOUNGE',0],['COFFEE / RESET',13]]){const sign=textSprite(caption,'#d6f2ed',.45);sign.position.set(x,2.3,rear-3.5);group.add(sign);}
 // A furnished studio occupies unused office rows on smaller teams.
 const usedRows=Math.ceil(f.residents.length/6);
 for(let row=usedRows;row<f.rows;row++){const z=f.depth/2-4.1-row*5.2;for(const x of [-13,-2,9]){furnish([x,.02,z],[8,.05,4.4],materials.rug);sofa(x,z-1,5.5);furnish([x,.5,z+.8],[3,.14,1]);plant(x+3,z+1);}}
 // Fill partial rows with focus booths and materials libraries, without inventing workers.
 for(let slot=f.residents.length;slot<usedRows*6;slot++){
  if(f.residents.length===1)break;
  const x=(slot%6-2.5)*5.8,z=f.depth/2-4.1-Math.floor(slot/6)*5.2;
  furnish([x,.02,z],[5,.04,4.2],materials.rug);sofa(x,z-1.2,3.7);furnish([x,.45,z+.3],[2,.12,1]);plant(x+1.8,z+1.2);
  furnish([x-2,1,z-1],[.45,2,1.7],materials.white);for(let shelf=0;shelf<4;shelf++){furnish([x-1.9,.35+shelf*.45,z-1],[.6,.06,1.7]);for(let j=0;j<5;j++)furnish([x-1.85,.5+shelf*.45,z-1.65+j*.3],[.4,.24,.15],j%2?accent:materials.book);}
 }
 if(f.residents.length===1){const z=f.residents[0].z;for(const x of [-11,11]){furnish([x,.02,z],[10,.04,4.2],materials.rug);sofa(x,z-1,6);furnish([x,.45,z+1],[4,.15,1]);plant(x-4,z);plant(x+4,z);}}
 // A continuous planted corridor and illuminated arrival threshold.
 for(let k=0;k<5;k++){plant(-plan.width/2+1, f.depth/2-3-k*(f.depth-6)/4);}
 furnish([0,.025,f.depth/2-1.4],[plan.width-1,.05,1.3],materials.rug);
 f.residents.forEach((r,i)=>{const x=r.x,z=r.z;officeMap.set(r.id,{...r,floor:rec});
 // Every agent has a carpeted office pod, doorway, storage and desk accessories.
 batch(cube,materials.rug,[x,.02,z],[5.05,.04,4.2],r.id);
 for(const px of [x-2.6,x+2.6]){batch(cube,materials.metal,[px,1.08,z-2.1],[.08,2.16,.08],r.id);batch(cube,accent,[px,.38,z],[.08,.76,4.2],r.id);}
 batch(cube,materials.glass,[x+2.6,1.05,z],[.07,2.1,4.2],r.id);
 batch(cube,materials.glass,[x-1.55,1.05,z+2.1],[2.1,2.1,.06],r.id);batch(cube,materials.metal,[x-.5,1.05,z+2.1],[.07,2.1,.07],r.id);
 batch(cube,materials.desk,[x-1.25,.8,z+.25],[.7,.14,1.65],r.id);
 batch(cube,materials.white,[x-1.05,.35,z-.2],[.65,.65,.8],r.id);for(let n=0;n<3;n++)batch(cube,materials.metal,[x-1.05,.18+n*.18,z+.215],[.35,.03,.035],r.id);
 batch(cube,materials.black,[x,.89,z+.05],[.82,.04,.28],r.id);for(let k=0;k<8;k++)batch(cube,materials.white,[x-.34+k*.095,.915,z+.05],[.045,.014,.19],r.id);
 batch(sphere,materials.black,[x+.6,.91,z+.05],[.08,.025,.12],r.id);batch(cylinder,materials.white,[x-.9,.96,z-.42],[.075,.22,.075],r.id);
 batch(cube,materials.book,[x+1.85,.48,z-.8],[.5,.95,.7],r.id);for(let j=0;j<4;j++)batch(cube,accent,[x+1.68+j*.1,1.05,z-.8],[.065,.22,.3],r.id);
 batch(cube,materials.chair,[x+1.3,.45,z+1],[.55,.12,.55],r.id);batch(cube,materials.chair,[x+1.3,.75,z+1.25],[.55,.5,.1],r.id);
 batch(cube,materials.metal,[x,2.25,z-1.8],[2.5,.08,.16]);batch(cube,materials.warm,[x,2.2,z-1.8],[2.3,.035,.12]);

 batch(cube,materials.glass,[x,1.05,z-2.1],[5.15,2.05,.07],r.id);batch(cube,materials.metal,[x,.24,z-2.1],[5.15,.48,.08],r.id);batch(cube,materials.light,[x,2.1,z-2.1],[5.15,.025,.08],r.id);batch(cube,materials.glass,[x-2.6,1.05,z],[.07,2.1,4.25],r.id);
 batch(cube,materials.desk,[x,.8,z-.25],[2.5,.14,1.05],r.id);batch(cube,materials.metal,[x-.95,.4,z-.25],[.12,.8,.7],r.id);batch(cube,materials.metal,[x+.95,.4,z-.25],[.12,.8,.7],r.id);
 batch(cube,materials.chair,[x,.5,z+1],[.65,.15,.65],r.id);batch(cube,materials.chair,[x,.9,z+1.3],[.65,.7,.12],r.id);
 batch(cube,materials.metal,[x,.99,z-.43],[.16,.3,.16],r.id);
 batch(cylinder,materials.metal,[x+.95,1.1,z-.35],[.04,.6,.04]);batch(sphere,materials.warm,[x+.95,1.43,z-.35],[.13,.06,.13]);
 const c=document.createElement('canvas');c.width=768;c.height=432;const tx=new T.CanvasTexture(c);tx.colorSpace=T.SRGBColorSpace;tx.anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy());const material=new T.MeshBasicMaterial({map:tx});const screen=mesh(new T.PlaneGeometry(1.45,.82),material,group,[x,1.42,z-.415],[1,1,1],{roleId:r.id,monitor:true,ctx:c.getContext('2d')});const nameplate=textSprite(`${String(r.office).padStart(2,'0')} / ${identity(r)}`,'#dffaf1',.3);nameplate.position.set(x,1.83,z-2.04);group.add(nameplate);officeMap.get(r.id).nameplate=nameplate;monitors.set(r.id,screen);setScreen(screen,r,assignmentFor(r.id,tasks));
 batch(cube,materials.metal,[x,1.42,z-.48],[1.58,.96,.09],r.id);
 // Low-poly person: individual body parts are instanced per floor and suit.
 const suit=suits[roles.findIndex(a=>a.id===r.id)%suits.length];const ax=x-.75,az=z+.85;const moving=[];
 for(const [geo,mat,p,s] of [[cube,materials.chair,[ax-.11,.24,az],[.13,.47,.16]],[cube,materials.chair,[ax+.11,.24,az],[.13,.47,.16]],[cylinder,suit,[ax,.78,az],[.28,.61,.18]],[cube,suit,[ax-.3,.75,az],[.12,.52,.15]],[cube,suit,[ax+.3,.75,az],[.12,.52,.15]],[cylinder,materials.skin,[ax,1.1,az],[.08,.15,.08]],[sphere,materials.skin,[ax,1.34,az],[.22,.26,.22]],[hair,materials.hair,[ax,1.43,az],[.235,.19,.235]]])moving.push(batch(geo,mat,p,s,r.id,true));
 // Shoes, hands, eyes and a shirt panel make residents readable at office scale.
 for(const dx of [-.11,.11])batch(cube,materials.black,[ax+dx,.045,az+.07],[.17,.09,.28],r.id,true);
 for(const dx of [-.3,.3])batch(sphere,materials.skin,[ax+dx,.48,az],[.075,.09,.075],r.id,true);
 batch(cube,materials.white,[ax,.86,az+.18],[.14,.35,.025],r.id,true);batch(cube,accent,[ax,.84,az+.2],[.04,.25,.018],r.id,true);
 for(const dx of [-.07,.07])batch(sphere,materials.black,[ax+dx,1.37,az+.21],[.025,.022,.018],r.id,true);
 const lightMat=new T.MeshBasicMaterial({color:COLORS[residentState(r.id,tasks)]||COLORS.available});const beacon=mesh(cylinder,lightMat,group,[x-2,.09,z+1.65],[.13,.07,.13],{roleId:r.id});officeMap.get(r.id).beacon=beacon;
 batch(cylinder,materials.pot,[x+1.85,.2,z-1.2],[.2,.38,.2]);batch(sphere,materials.plant,[x+1.85,.65,z-1.2],[.35,.5,.35]);
 // Assistant orb is a decorative companion, not a second executing agent.
 batch(sphere,materials.light,[x+1.4,1.5,z+.9],[.12,.12,.12]);
 });
 for(const bucket of rec.batches.values()){const inst=new T.InstancedMesh(bucket.geo,bucket.mat,bucket.items.length);inst.castShadow=bucket.mat!==materials.glass&&bucket.mat!==materials.light&&bucket.mat!==materials.warm;inst.receiveShadow=true;inst.userData.items=bucket.items;bucket.items.forEach((item,i)=>{dummy.position.set(...item.pos);dummy.scale.set(...item.scale);dummy.rotation.set(0,0,0);dummy.updateMatrix();inst.setMatrixAt(i,dummy.matrix);if(item.animate)animated.push({mesh:inst,index:i,item,floor:rec,phase:roles.findIndex(r=>r.id===item.id)*.53});});group.add(inst);picks.push(inst);}
 }
 // Rooftop crown, warm lobby trees and original landscaped foundation.
 for(let i=0;i<10;i++){const x=-plan.width/2-2+(i%5)*(plan.width+4)/4,z=i<5?plan.depth/2+2:-plan.depth/2-2;mesh(cylinder,materials.pot,world,[x,.2,z],[.55,.8,.55]);mesh(cylinder,materials.desk,world,[x,1.2,z],[.12,1.5,.12]);mesh(sphere,materials.plant,world,[x,2.25,z],[.9,1.2,.9]);}
 setMode(mode,false);refreshStates();host.dataset.residents=String(roles.length);host.dataset.floors=String(floors.length);host.dataset.renderer='webgl';
 }
 function flightTo(position,target){flight={from:camera.position.clone(),to:new T.Vector3(...position),fromTarget:controls.target.clone(),target:new T.Vector3(...target),at:performance.now()};if(matchMedia('(prefers-reduced-motion: reduce)').matches){camera.position.copy(flight.to);controls.target.copy(flight.target);flight=null;}controls.update();}
 function frameBuilding(){const top=(floors.length-1)*(mode==='exploded'?7.6:3.7);flightTo([52,top*.45+9,76],[0,top*.45,0]);}
 function setMode(next,move=true){mode=next;for(const child of world.children)if(!floors.some(f=>f.group===child))child.visible=next!=='floor';sun.shadow.autoUpdate=next==='floor';renderer.shadowMap.enabled=next==='floor';focused=next==='floor'?focused:null;for(const f of floors){f.group.visible=next!=='floor'||f.name===focused;f.title.visible=next!=='floor';for(const child of f.group.children)if(child.userData.ceiling)child.visible=next!=='floor';f.group.position.set(0,next==='floor'?0:f.index*(next==='exploded'?7.6:3.7),0);}world.children.filter(c=>c.userData?.spine).forEach(c=>{c.visible=next!=='floor';if(next!=='floor'){const height=(floors.length-1)*(next==='exploded'?7.6:3.7)+3;c.position.y=height/2;c.scale.y=height;}});if(move){if(next==='floor'){const f=floors.find(f=>f.name===focused),scale=Math.max(1,(f?.depth||30)/36,1/camera.aspect*.8);flightTo([28*scale,29*scale,35*scale],[0,0,0]);}else frameBuilding();}for(const child of world.children)if(child.userData.decorativeLabel)child.visible=next!=='floor';host.dataset.mode=mode;for(const id of ['sceneTower','sceneExplode','sceneFloor'])$(id)?.setAttribute('aria-pressed',String(mode===({sceneTower:'tower',sceneExplode:'exploded',sceneFloor:'floor'}[id])));$('sceneMode').textContent=mode==='floor'?`${focused} / all residents`:mode==='exploded'?'Separated floors / whole company':'Glass tower / whole company';}
 function enterFloor(name){focused=name;setMode('floor');}
 function focusAgent(id,taskId=null){selected=id;selectedTaskId=taskId;const r=officeMap.get(id);if(!r)return;focused=r.department;setMode('floor',false);flightTo([r.x+4.5,4.8,r.z+6.2],[r.x,1,r.z]);refreshStates();}
 function refreshStates(){for(const r of officeMap.values()){const plate=r.nameplate,label=`${String(r.office).padStart(2,'0')} / ${identity(r)}`;if(plate&&plate.userData.labelText!==label){const ctx=plate.userData.labelContext;ctx.fillStyle='#102837';ctx.fillRect(0,0,768,96);ctx.fillStyle=plate.userData.labelColor;ctx.font='500 37px system-ui';ctx.fillText(label,24,62);plate.material.map.needsUpdate=true;plate.userData.labelText=label;}const state=residentState(r.id,tasks);r.beacon.material.color.setHex(COLORS[state]||COLORS.available);setScreen(monitors.get(r.id),r,assignmentFor(r.id,tasks,r.id===selected?selectedTaskId:null));}const r=officeMap.get(selected);highlight.visible=Boolean(r&&r.floor.group.visible);if(r)highlight.position.set(r.x-.75,r.floor.group.position.y+.07,r.z+.85);}
 function pick(e){const rect=renderer.domElement.getBoundingClientRect();pointer.set((e.clientX-rect.left)/rect.width*2-1,-(e.clientY-rect.top)/rect.height*2+1);raycaster.setFromCamera(pointer,camera);const hits=raycaster.intersectObjects(picks,false).filter(h=>{let o=h.object;while(o){if(!o.visible)return false;o=o.parent;}return true;});for(const h of hits){if(h.object.material===materials.glass)continue;const data=h.instanceId!=null?h.object.userData.items?.[h.instanceId]:h.object.userData;if(data?.id)return{roleId:data.id};if(data?.roleId)return data;if(data?.floor)return data;}return null;}
 let down=null;renderer.domElement.addEventListener('pointerdown',e=>{down=[e.clientX,e.clientY];flight=null;autorotate=false;$('sceneRotate')?.setAttribute('aria-pressed','false');});renderer.domElement.addEventListener('pointerup',e=>{if(!down||Math.hypot(e.clientX-down[0],e.clientY-down[1])>6)return;const hit=pick(e);if(hit?.roleId){selected=hit.roleId;refreshStates();onAgent(hit.roleId);if(hit.monitor)onMonitor(hit.roleId);}else if(hit?.floor)onFloor(hit.floor);});renderer.domElement.addEventListener('pointermove',e=>{if(e.buttons)return;const hit=pick(e),r=roles.find(r=>r.id===hit?.roleId);tooltip.hidden=!hit;if(hit){tooltip.textContent=r?`${identity(r)} · ${r.name} · ${residentState(r.id,tasks)}`:hit.floor;const rect=host.getBoundingClientRect();tooltip.style.left=`${Math.min(rect.width-220,Math.max(8,e.clientX-rect.left+12))}px`;tooltip.style.top=`${Math.max(8,e.clientY-rect.top-30)}px`;renderer.domElement.style.cursor='pointer';}else renderer.domElement.style.cursor='grab';});renderer.domElement.addEventListener('pointerleave',()=>tooltip.hidden=true);
 renderer.domElement.addEventListener('keydown',e=>{if(e.key==='Escape'){setMode('tower');}if(e.key==='+'||e.key==='='){camera.position.lerp(controls.target,.12);controls.update();}if(e.key==='-'){camera.position.sub(controls.target).multiplyScalar(1.12).add(controls.target);controls.update();}});
 controls.addEventListener('start',()=>{flight=null;});
 function resize(){const w=host.clientWidth,h=host.clientHeight;if(!w||!h)return;const ratio=Math.min(Math.max(devicePixelRatio,1.5),2.5,Math.sqrt(8000000/(w*h)));renderer.setPixelRatio(ratio);host.dataset.pixelRatio=ratio.toFixed(2);renderer.setSize(w,h);camera.aspect=w/h;camera.updateProjectionMatrix();}
 new ResizeObserver(resize).observe(host);new IntersectionObserver(es=>visible=es[0].isIntersecting).observe(host);
 function animate(at){requestAnimationFrame(animate);if(document.hidden||!visible||$('officeView').hidden)return;if(at-lastRender<32)return;lastRender=at;frame++;if(flight){const t=Math.min(1,(at-flight.at)/650),ease=t*t*(3-2*t);camera.position.lerpVectors(flight.from,flight.to,ease);controls.target.lerpVectors(flight.fromTarget,flight.target,ease);if(t===1)flight=null;}
 controls.autoRotate=autorotate&&!paused&&!matchMedia('(prefers-reduced-motion: reduce)').matches;controls.autoRotateSpeed=.45;controls.update();
 if(!paused&&!matchMedia('(prefers-reduced-motion: reduce)').matches&&mode==='floor'&&frame%2===0){const changed=new Set();for(const a of animated){if(!a.floor.group.visible)continue;const state=residentState(a.item.id,tasks),walk=state==='available'?Math.max(0,Math.sin(at*.00032+a.phase))*.45:0;dummy.position.set(a.item.pos[0]+walk,a.item.pos[1],a.item.pos[2]);dummy.scale.set(...a.item.scale);dummy.rotation.set(0,0,0);dummy.updateMatrix();a.mesh.setMatrixAt(a.index,dummy.matrix);changed.add(a.mesh);}for(const m of changed)m.instanceMatrix.needsUpdate=true;}
 for(const l of labels){l.element.hidden=mode==='floor';if(mode!=='floor'){const v=new T.Vector3(plan.width/2,l.floor.group.position.y+.2,l.floor.depth/2).project(camera);l.element.style.left=`${(v.x*.5+.5)*host.clientWidth}px`;l.element.style.top=`${(-v.y*.5+.5)*host.clientHeight}px`;l.element.hidden=v.z>1||v.x>1||v.x<-1||v.y>1||v.y<-1;}}
 renderer.render(scene,camera);
 }
 $('sceneTower').onclick=()=>setMode('tower');$('sceneExplode').onclick=()=>setMode('exploded');$('sceneFloor').onclick=()=>enterFloor(focused||'Engineering');$('sceneReset').onclick=()=>{setMode('tower');};$('sceneRotate').onclick=()=>{autorotate=!autorotate;$('sceneRotate').setAttribute('aria-pressed',String(autorotate));};$('sceneLight').onclick=()=>{theme=theme==='night'?'day':'night';renderer.setClearColor(theme==='night'?0x071019:0x223c4b);renderer.toneMappingExposure=theme==='night'?1.35:1.9;$('sceneLight').textContent=theme==='night'?'Day lighting':'Night lighting';};
 camera.position.set(85,65,105);resize();requestAnimationFrame(animate);
 return {update(nextRoles,nextTasks){tasks=nextTasks;const changed=JSON.stringify(roles)!==JSON.stringify(nextRoles);roles=nextRoles;if(changed){build();frameBuilding();}else refreshStates();},enterFloor,focusAgent,setMode,select(id,taskId=null){selected=id;selectedTaskId=taskId;refreshStates();},pause(v){paused=v;},resize};
}
