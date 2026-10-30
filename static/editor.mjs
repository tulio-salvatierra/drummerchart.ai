import {initialChart,snap,move,split,merge,exportChart} from './chart.mjs';
const $=id=>document.getElementById(id);
let ctx, buffers=[], gains=[], sources=[], playing=false, offset=0, epoch=0, result, predicted, sections=[], selected=0;
const position=()=>playing?Math.min(result.duration,offset+ctx.currentTime-epoch):offset;
function stop(){offset=position();sources.forEach(s=>s.stop());sources=[];playing=false;$('play').textContent='Play';}
async function play(){await ctx.resume();if(offset>=result.duration)offset=0;epoch=ctx.currentTime+.05;sources=buffers.map((b,i)=>{const s=ctx.createBufferSource();s.buffer=b;s.connect(gains[i]);s.start(epoch,offset);return s;});playing=true;$('play').textContent='Pause';}
function draw(buffer,id){const c=$(id);c.width=1000;c.height=130;const g=c.getContext('2d'),data=buffer.getChannelData(0);g.fillStyle='#70d9c5';for(let x=0;x<c.width;x++){let peak=0;for(let j=Math.floor(x*data.length/c.width);j<Math.floor((x+1)*data.length/c.width);j++)peak=Math.max(peak,Math.abs(data[j]));g.fillRect(x,65-peak*60,1,Math.max(1,peak*120));}}
function render(){const t=$('timeline');t.replaceChildren();sections.forEach((s,i)=>{const b=document.createElement('button');b.textContent=s.label+' · '+(s.confirmed?'user-confirmed':s.label==='Unknown'?'predicted · Unknown':'edited · unconfirmed');b.title=s.start.toFixed(2)+'–'+s.end.toFixed(2)+' seconds';b.style.flex=String(s.end-s.start);b.setAttribute('aria-pressed',i===selected);b.onclick=()=>{selected=i;render();};t.append(b);});$('label').value=sections[selected].label;$('start').value=sections[selected].start.toFixed(3);$('start').disabled=selected===0;}
function edit(fn){try{fn();render();$('status').textContent='Chart updated locally.';}catch(e){$('status').textContent=e.message;}}
$('upload').onsubmit=async e=>{e.preventDefault();$('analyze').disabled=true;$('status').textContent='Analyzing…';if(playing)stop();$('result').hidden=true;try{
 const file=$('file').files[0],form=new FormData();form.append('file',file);
 const response=await fetch('/analyze/result',{method:'POST',body:form});const data=await response.json();if(!response.ok)throw Error(data.detail);
 if(ctx)await ctx.close();ctx=new AudioContext();result=data;
 buffers=await Promise.all([ctx.decodeAudioData(await file.arrayBuffer()),ctx.decodeAudioData(Uint8Array.from(atob(data.click_wav_base64),c=>c.charCodeAt(0)).buffer)]);
 gains=buffers.map((_,i)=>{const g=ctx.createGain();g.gain.value=Number($(i?'clickVolume':'originalVolume').value);g.connect(ctx.destination);return g;});
 predicted=initialChart(result);sections=structuredClone(predicted);selected=0;offset=0;
 draw(buffers[0],'original');draw(buffers[1],'click');$('seek').max=result.duration;render();$('result').hidden=false;$('status').textContent='Ready. Unknown labels are predicted placeholders; confirm only after review.';
 }catch(e){$('status').textContent=e.message;}finally{$('analyze').disabled=false;}};
$('play').onclick=()=>playing?stop():play().catch(e=>$('status').textContent=e.message);
$('seek').oninput=async()=>{const resume=playing;if(resume)stop();offset=Number($('seek').value);if(resume)await play();};
['originalVolume','clickVolume'].forEach((id,i)=>$(id).oninput=()=>{if(gains[i])gains[i].gain.value=Number($(id).value);});
$('apply').onclick=()=>edit(()=>{const label=$('label').value.trim();if(!label)throw Error('Enter a label.');const s=sections[selected],t=snap(Number($('start').value),result.beat_times,$('snap').checked);if(selected&&Math.abs(Number($('start').value)-s.start)>.001)move(sections,selected,t);if(label!==s.label){s.label=label;s.confirmed=false;}});
$('confirm').onclick=()=>edit(()=>{sections[selected].confirmed=true;});
$('split').onclick=()=>edit(()=>split(sections,selected,snap(position(),result.beat_times,$('snap').checked)));
$('merge').onclick=()=>edit(()=>merge(sections,selected));
$('export').onclick=()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(exportChart(result,predicted,sections),null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='corrected-chart.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
function tick(){if(result){if(playing&&position()>=result.duration)stop();$('seek').value=Math.max(0,position());$('time').textContent=Math.max(0,position()).toFixed(1)+' / '+result.duration.toFixed(1)+' s';}requestAnimationFrame(tick);}tick();
