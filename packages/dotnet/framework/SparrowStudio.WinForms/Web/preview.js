'use strict';
(()=>{
const $=id=>document.getElementById(id), svg=$('canvas'), ns='http://www.w3.org/2000/svg';
let job=null,best=null,current=null,mode='best',bounds=[0,0,1000,1000],view=null,drag=null;
const palette=['#6fa8cd','#ddab6e','#91b68b','#b09ac5','#d58e8a','#77b7b5','#b5b874'];
const send=type=>window.chrome.webview.postMessage({type});
for(const type of ['stop','cancel','apply','close']) $(type).onclick=()=>send(type);
const budgetInputs=['totalSeconds','initialSeconds','insertionSeconds','compressionSeconds','insertionFailures'];
$('start').onclick=()=>{
 if(budgetInputs.some(id=>!$(id).reportValidity()))return;
 const settings={timeLimitSeconds:$('totalSeconds').value===''?null:Number($('totalSeconds').value),sheetInitialSearchSeconds:Number($('initialSeconds').value),sheetInsertionWarmStartSeconds:Number($('insertionSeconds').value),sheetCompressionSeconds:Number($('compressionSeconds').value),sheetInsertionFailures:Number($('insertionFailures').value)};
 if((settings.timeLimitSeconds!==null&&(!Number.isInteger(settings.timeLimitSeconds)||settings.timeLimitSeconds<1||settings.timeLimitSeconds>600))||!Number.isFinite(settings.sheetInitialSearchSeconds)||settings.sheetInitialSearchSeconds<.1||settings.sheetInitialSearchSeconds>600||[settings.sheetInsertionWarmStartSeconds,settings.sheetCompressionSeconds].some(n=>!Number.isInteger(n)||n<1||n>600)||!Number.isInteger(settings.sheetInsertionFailures)||settings.sheetInsertionFailures<1||settings.sheetInsertionFailures>100)return;
 window.chrome.webview.postMessage({type:'start',settings});
};
function element(tag,attrs,parent){const node=document.createElementNS(ns,tag);for(const key in attrs)node.setAttribute(key,String(attrs[key]));parent.appendChild(node);return node;}
function path(points){return (points||[]).map((p,i)=>(i?'L':'M')+p[0]+' '+p[1]).join(' ')+'Z';}
function shape(outer,holes){return path(outer)+(holes||[]).map(path).join(' ');}
function setView(){if(view)svg.setAttribute('viewBox',view.join(' '));}
function fit(){const w=Math.max(1,svg.clientWidth),h=Math.max(1,svg.clientHeight),ratio=w/h;let bw=bounds[2]*1.12,bh=bounds[3]*1.12;if(bw/bh<ratio)bw=bh*ratio;else bh=bw/ratio;view=[bounds[0]+bounds[2]/2-bw/2,bounds[1]+bounds[3]/2-bh/2,bw,bh];setView();}
function zoom(f,x=.5,y=.5){if(!view)return;view=[view[0]+view[2]*x*(1-f),view[1]+view[3]*y*(1-f),view[2]*f,view[3]*f];setView();}
function render(){
 if(!job)return;const result=mode==='best'?best:current;svg.replaceChildren();$('empty').style.display=result?'none':'flex';if(!result)return;
 const parts=new Map(job.parts.map((p,i)=>[p.id,{...p,color:palette[i%palette.length]}]));
 const sheets=result.sheets&&result.sheets.length?result.sheets:[{job,result}];let offset=0,maxWidth=0,placed=0;
 for(let i=0;i<sheets.length;i++){const entry=sheets[i],settings=(entry.job||job).settings||{},stock=settings.sheetStock||(settings.sheetStocks||[])[0]||{};
 const width=stock.lengthMm||settings.sheetLengthMm||entry.result.usedLengthMm||1000,height=stock.widthMm||settings.materialWidthMm||1000,gap=Math.max(height*.13,40);
 const board=element('g',{transform:'translate(0 '+offset+')'},svg);element('rect',{x:0,y:0,width,height,fill:'#fafcfd',stroke:'#b7c5ce','stroke-width':1,'vector-effect':'non-scaling-stroke'},board);
 const caption=element('text',{x:0,y:-Math.min(gap*.25,18),'font-size':Math.max(10,height*.023),fill:'#6a7e8b'},board);caption.textContent='BOARD '+String(i+1).padStart(2,'0')+'  ·  '+Math.round(width)+' × '+Math.round(height)+' mm';
 const geometry=element('g',{transform:'translate(0 '+height+') scale(1 -1)'},board);
 if(stock.outer)element('path',{d:shape(stock.outer,stock.holes),fill:'#f1f5f7',stroke:'#a8b9c5','fill-rule':'evenodd','vector-effect':'non-scaling-stroke'},geometry);
 for(const placement of entry.result.placements||[]){const part=parts.get(placement.partId);if(!part)continue;placed++;const group=element('g',{transform:'translate('+placement.xMm+' '+placement.yMm+') rotate('+placement.angleDeg+')'},geometry);const node=element('path',{d:shape(part.outer,part.holes),fill:part.color,stroke:'#344c59','stroke-width':.7,'fill-rule':'evenodd','vector-effect':'non-scaling-stroke'},group);const title=element('title',{},node);title.textContent=part.name+' · '+(placement.copyIndex+1);}
 offset+=height+gap;maxWidth=Math.max(maxWidth,width);}
 bounds=[0,-Math.max(30,(job.settings.materialWidthMm||1000)*.05),maxWidth,offset];
 $('sheets').textContent=sheets.length;$('parts').textContent=placed+' / '+Math.max(0,job.parts.reduce((n,p)=>n+p.quantity,0)-placed);$('round').textContent=result.roundIndex!=null?'第 '+result.roundIndex+' 轮':'原生候选快照';if(!view)fit();
}
for(const tab of ['best','current'])$(tab).onclick=()=>{mode=tab;$('best').classList.toggle('selected',tab==='best');$('current').classList.toggle('selected',tab==='current');view=null;render();};
$('fit').onclick=fit;$('plus').onclick=()=>zoom(.8);$('minus').onclick=()=>zoom(1.25);
svg.addEventListener('wheel',e=>{e.preventDefault();const r=svg.getBoundingClientRect();zoom(e.deltaY>0?1.12:.89,(e.clientX-r.left)/r.width,(e.clientY-r.top)/r.height);},{passive:false});
svg.onpointerdown=e=>{if(!view)return;drag=[e.clientX,e.clientY,view.slice()];svg.setPointerCapture(e.pointerId);};svg.onpointermove=e=>{if(!drag)return;view=[drag[2][0]-(e.clientX-drag[0])*drag[2][2]/svg.clientWidth,drag[2][1]-(e.clientY-drag[1])*drag[2][3]/svg.clientHeight,drag[2][2],drag[2][3]];setView();};svg.onpointerup=svg.onpointercancel=()=>drag=null;
window.chrome.webview.addEventListener('message',event=>{const m=event.data;if(m.type==='job'){job=m.job;const s=job.settings;$('totalSeconds').value=s.timeLimitSeconds==null?'':String(s.timeLimitSeconds);$('initialSeconds').value=s.sheetInitialSearchSeconds??2.5;$('insertionSeconds').value=s.sheetInsertionWarmStartSeconds??1;$('compressionSeconds').value=s.sheetCompressionSeconds??1;$('insertionFailures').value=s.sheetInsertionFailures??1;$('jobName').textContent=job.name;$('parts').textContent='0 / '+job.parts.reduce((n,p)=>n+p.quantity,0);}else if(m.type==='snapshot'){if(m.best)best=m.best;if(m.current)current=m.current;if(m.stopped){mode='current';$('best').classList.remove('selected');$('current').classList.add('selected');view=null;}$('sequence').textContent='原生快照 #'+(m.sequence||'final');render();}else if(m.type==='state'){$('start').disabled=m.started;$('budgetSettings').disabled=m.started;for(const id of budgetInputs)$(id).disabled=m.started;$('stop').disabled=!m.canStop;$('cancel').disabled=!m.started;$('apply').disabled=!m.canApply;$('apply').textContent=m.stopped?'应用当前轮结果':'应用结果';$('phase').textContent=m.phase;$('status').textContent=m.stopping?'正在截止':m.stopped?(m.canApply?'已截止待应用':'截止快照未完整不可应用'):m.running?'正在计算':m.canApply?'等待应用':m.started?'已结束':'准备就绪';$('elapsed').textContent=(m.elapsed||0).toFixed(1);$('budget').textContent=m.budget==null?'秒 / 自动（无总 deadline）':'秒 / '+m.budget+' 秒共享预算';$('bar').style.width=m.budget==null?'0%':Math.min(100,(m.elapsed||0)/m.budget*100)+'%';}else if(m.type==='error')$('error').textContent=m.message;});
send('ready');
})();