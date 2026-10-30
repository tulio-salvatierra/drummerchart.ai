import {viewport,barLoop} from './timeline.mjs';
import {initialChart,snap,move,split,merge,exportChart} from './chart.mjs';
const $=id=>document.getElementById(id);
let ctx, buffers=[], gains=[], sources=[], playing=false, offset=0, epoch=0, result, predicted, sections=[], selected=0;
const position=()=>playing?Math.min(result.duration,offset+ctx.currentTime-epoch):offset;
function stop(){offset=position();sources.forEach(s=>s.stop());sources=[];playing=false;$('play').textContent='Play';}
async function play(){await ctx.resume();if(offset>=result.duration)offset=0;epoch=ctx.currentTime+.05;sources=buffers.map((b,i)=>{const s=ctx.createBufferSource();s.buffer=b;s.connect(gains[i]);s.start(epoch,offset);return s;});playing=true;$('play').textContent='Pause';}
function draw(buffer,id,channel=0){const c=$(id);c.width=1000;c.height=130;const g=c.getContext('2d'),data=buffer.getChannelData(channel);g.fillStyle='#70d9c5';for(let x=0;x<c.width;x++){let peak=0;for(let j=Math.floor(x*data.length/c.width);j<Math.floor((x+1)*data.length/c.width);j++)peak=Math.max(peak,Math.abs(data[j]));g.fillRect(x,65-peak*60,1,Math.max(1,peak*120));}}
function render(){const t=$('timeline');t.replaceChildren();sections.forEach((s,i)=>{const b=document.createElement('button');b.textContent=s.label+' · '+(s.confirmed?'user-confirmed':s.label==='Unknown'?'predicted · Unknown':'edited · unconfirmed');b.title=s.start.toFixed(2)+'–'+s.end.toFixed(2)+' seconds';b.style.flex=String(s.end-s.start);b.setAttribute('aria-pressed',i===selected);b.onclick=()=>{selected=i;render();};t.append(b);});$('label').value=sections[selected].label;$('start').value=sections[selected].start.toFixed(3);$('start').disabled=selected===0;}
function edit(fn){try{fn();render();$('status').textContent='Chart updated locally.';}catch(e){$('status').textContent=e.message;}}
let tempoPrediction, tempoFile, originalURL, auditionURL;
let reviewBuffers={},view={start:0,end:1},auditionData,loopRange,loopContext,loopSource,loopEpoch=0;
function stopReviewLoop(){if(loopSource){loopSource.stop();loopSource=null;}$('playLoop').textContent='Play loop';}
function reviewPosition(){return loopSource?loopRange.start+(loopContext.currentTime-loopEpoch)%(loopRange.end-loopRange.start):reviewAudio().currentTime||0;}
function drawReview(id,buffer,channel=0){
 if(!buffer)return;
 const canvas=$(id);canvas.width=1000;canvas.height=130;const g=canvas.getContext('2d'),data=buffer.getChannelData(channel);
 g.clearRect(0,0,1000,130);g.fillStyle='#70d9c5';
 for(let x=0;x<1000;x++){let peak=0;const from=Math.floor((view.start+(view.end-view.start)*x/1000)*buffer.sampleRate),to=Math.min(data.length,Math.ceil((view.start+(view.end-view.start)*(x+1)/1000)*buffer.sampleRate));for(let j=from;j<to;j++)peak=Math.max(peak,Math.abs(data[j]||0));g.fillRect(x,65-peak*60,1,Math.max(1,peak*120));}
}
function renderView(center=reviewPosition()){
 if(!tempoPrediction)return;
 view=viewport(tempoPrediction.duration,Number($('zoom').value),center);
 for(const id of ['reviewSeek','oneDrag']){$(id).min=view.start;$(id).max=view.end;$(id).step='.001';}
 $('viewRange').textContent=view.start.toFixed(3)+'–'+view.end.toFixed(3)+' s';
 drawReview('reviewOriginal',reviewBuffers.original);drawReview('reviewClick',reviewBuffers.click,1);updateReview();
}

function invalidate(){stopReviewLoop();loopRange=null;auditionData=null;reviewBuffers.click=null;$('loopStatus').textContent='Rebuild audition and set loop after editing.';$('reviewStack').hidden=false;stopReviewLoop();if(playing)stop();$('tempoAudio').pause();$('countAudio').pause();$('countAudio').hidden=true;$('countAudio').removeAttribute('src');if(auditionURL){URL.revokeObjectURL(auditionURL);auditionURL=null;}$('reviewPlay').textContent='Play original';$('reviewClick').getContext('2d').clearRect(0,0,1000,130);$('clickHint').textContent='Rebuild audition for the current map.';$('meterStatus').textContent='Unconfirmed: audition the current meter and first ONE.';$('result').hidden=true;$('approveCheck').checked=false;$('status').textContent='Tempo changed. Review and approve again before generating sections or click.';}
function addTempoRow(start=0,bpm=120){
 const row=document.createElement('div');
 for(const [name,value] of [['Beat anchor (seconds)',start],['BPM',bpm]]){
  const label=document.createElement('label');label.textContent=name;
  const input=document.createElement('input');input.type='number';input.step='0.001';input.value=value;input.setAttribute('aria-label',name);
  input.oninput=invalidate;label.append(input);row.append(label);
 }
 const remove=document.createElement('button');remove.textContent='Remove tempo row';remove.onclick=()=>{row.remove();invalidate();};row.append(remove);$('tempoRows').append(row);
}
$('addTempo').onclick=()=>{addTempoRow();invalidate();};
$('overrideTempo').onchange=invalidate;
$('file').onchange=()=>{invalidate();$('tempoReview').hidden=true;tempoFile=null;};
$('upload').onsubmit=async e=>{
 e.preventDefault();invalidate();$('tempoReview').hidden=true;$('analyze').disabled=true;$('status').textContent='Detecting tempo only…';
 tempoFile=$('file').files[0];$('file').disabled=true;
 try{
  const form=new FormData();form.append('file',tempoFile);
  const response=await fetch('/tempo',{method:'POST',body:form});const data=await response.json();if(!response.ok)throw Error(data.detail);
  tempoPrediction=data;$('meter').value='3';$('pattern').value='quarter';$('firstOne').value=data.beat_times[0].toFixed(3);$('tempoRows').replaceChildren();addTempoRow(Number(data.beat_times[0].toFixed(3)),Number(data.estimated_bpm.toFixed(3)));$('overrideTempo').checked=false;
  if(originalURL)URL.revokeObjectURL(originalURL);originalURL=URL.createObjectURL(tempoFile);$('tempoAudio').src=originalURL;
  const decoder=new AudioContext();try{reviewBuffers.original=await decoder.decodeAudioData(await tempoFile.arrayBuffer());}finally{await decoder.close();}
  $('reviewSeek').max=data.duration;$('oneDrag').max=data.duration-.001;$('oneDrag').value=$('firstOne').value;$('zoom').value='1';renderView(0);
  $('tempoSummary').textContent=data.estimated_bpm.toFixed(1)+' BPM estimated · '+data.assessment+' · central tempo spread '+data.tempo_spread_bpm.toFixed(1)+' BPM';
  const values=data.beat_times.slice(1).map((t,i)=>60/(t-data.beat_times[i]));
  const low=Math.min(...values),high=Math.max(...values),canvas=$('tempoGraph');canvas.width=1000;canvas.height=130;
  const g=canvas.getContext('2d');g.clearRect(0,0,1000,130);g.strokeStyle='#70d9c5';g.beginPath();
  values.forEach((v,i)=>{const x=data.beat_times[i]/data.duration*1000,y=120-(v-low)/Math.max(1,high-low)*110;i?g.lineTo(x,y):g.moveTo(x,y);});g.stroke();
  $('tempoRange').textContent='Time: 0–'+data.duration.toFixed(1)+' s · Tempo range: '+low.toFixed(1)+'–'+high.toFixed(1)+' BPM';
  $('tempoReview').hidden=false;$('status').textContent='Review the original and tempo map. No sections or click have been generated.';
 }catch(e){$('status').textContent=e.message;}finally{$('analyze').disabled=false;$('file').disabled=false;}
};
$('approveTempo').onclick=async()=>{
 if(!$('approveCheck').checked){$('status').textContent='Please review and approve the tempo map first.';return;}
 stopReviewLoop();if(playing)stop();$('countAudio').pause();$('tempoAudio').pause();$('result').hidden=true;$('approveTempo').disabled=true;$('analyze').disabled=true;$('file').disabled=true;
 const reviewControls=[...$('tempoReview').querySelectorAll('input,button,select')];reviewControls.forEach(c=>c.disabled=true);
 try{
  const segments=$('overrideTempo').checked?[...$('tempoRows').children].map(row=>{const inputs=row.querySelectorAll('input');if([...inputs].some(i=>!i.value.trim()))throw Error('Fill every tempo value.');return {start:Number(inputs[0].value),bpm:Number(inputs[1].value)};}):null;
  const form=new FormData();form.append('file',tempoFile);form.append('review',JSON.stringify({confirmed:true,source_sha256:tempoPrediction.source_sha256,segments,meter:readMeter()}));
  $('status').textContent='Finding sections and generating the approved click…';
  const response=await fetch('/tempo/approve',{method:'POST',body:form});const data=await response.json();if(!response.ok)throw Error(data.detail);
  if(ctx)await ctx.close();ctx=new AudioContext();result=data;
  buffers=await Promise.all([ctx.decodeAudioData(await tempoFile.arrayBuffer()),ctx.decodeAudioData(Uint8Array.from(atob(data.click_wav_base64),c=>c.charCodeAt(0)).buffer)]);
  gains=buffers.map((_,i)=>{const g=ctx.createGain();g.gain.value=Number($(i?'clickVolume':'originalVolume').value);g.connect(ctx.destination);return g;});
  predicted=initialChart(result);sections=structuredClone(predicted);selected=0;offset=0;
  draw(buffers[0],'original');draw(buffers[1],'click');$('seek').max=result.duration;render();$('reviewStack').hidden=true;$('result').hidden=false;$('status').textContent='Tempo approved. Review predicted sections below.';
 }catch(e){$('status').textContent=e.message;}finally{reviewControls.forEach(c=>c.disabled=false);$('analyze').disabled=false;$('file').disabled=false;}
};
$('play').onclick=()=>{if(playing)stop();else{$('countAudio').pause();$('tempoAudio').pause();play().catch(e=>$('status').textContent=e.message);}};
$('seek').oninput=async()=>{const resume=playing;if(resume)stop();offset=Number($('seek').value);if(resume)await play();};
['originalVolume','clickVolume'].forEach((id,i)=>$(id).oninput=()=>{if(gains[i])gains[i].gain.value=Number($(id).value);});
$('apply').onclick=()=>edit(()=>{const label=$('label').value.trim();if(!label)throw Error('Enter a label.');const s=sections[selected],t=snap(Number($('start').value),result.beat_times,$('snap').checked);if(selected&&Math.abs(Number($('start').value)-s.start)>.001)move(sections,selected,t);if(label!==s.label){s.label=label;s.confirmed=false;}});
$('confirm').onclick=()=>edit(()=>{sections[selected].confirmed=true;});
$('split').onclick=()=>edit(()=>split(sections,selected,snap(position(),result.beat_times,$('snap').checked)));
$('merge').onclick=()=>edit(()=>merge(sections,selected));
$('export').onclick=()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(exportChart(result,predicted,sections),null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='corrected-chart.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
function tick(){if(result){if(playing&&position()>=result.duration)stop();$('seek').value=Math.max(0,position());$('result').style.setProperty('--playhead',(Math.max(0,position())/result.duration*100)+'%');$('result').style.setProperty('--one',((result.meter_review?.first_one||0)/result.duration*100)+'%');$('time').textContent=Math.max(0,position()).toFixed(1)+' / '+result.duration.toFixed(1)+' s';}requestAnimationFrame(tick);}tick();

function readMeter(){
 if(!$('firstOne').value.trim())throw Error('Mark the first ONE.');
 return {numerator:Number($('meter').value),denominator:4,pattern:$('pattern').value,first_one:Number($('firstOne').value)};
}
$('meter').onchange=()=>{if($('pattern').value==='332'&&$('meter').value!=='4')$('pattern').value='quarter';invalidate();};
$('pattern').onchange=()=>{if($('pattern').value==='332')$('meter').value='4';invalidate();};
$('firstOne').oninput=()=>{$('oneDrag').value=$('firstOne').value;invalidate();updateReview();};
$('markOne').onclick=()=>{const t=reviewPosition();$('firstOne').value=t.toFixed(3);$('oneDrag').value=t;invalidate();$('tempoAudio').currentTime=t;updateReview();};
$('oneDrag').oninput=()=>{const t=Number($('oneDrag').value);$('firstOne').value=t.toFixed(3);invalidate();$('tempoAudio').currentTime=t;updateReview();};
$('tempoAudio').onplay=()=>{if(playing)stop();$('countAudio').pause();};
$('countAudio').onplay=()=>{if(playing)stop();$('tempoAudio').pause();};
$('audition').onclick=async()=>{
 const controls=[...$('tempoReview').querySelectorAll('input,button,select'),$('file'),$('analyze')];
 try{
  const meter=readMeter();
  const segments=$('overrideTempo').checked?[...$('tempoRows').children].map(row=>{
   const i=row.querySelectorAll('input');if([...i].some(x=>!x.value.trim()))throw Error('Fill every tempo value.');
   return {start:Number(i[0].value),bpm:Number(i[1].value)};
  }):null;
  stopReviewLoop();if(playing)stop();$('tempoAudio').pause();$('countAudio').pause();
  controls.forEach(c=>c.disabled=true);$('meterStatus').textContent='Building count audition…';
  const form=new FormData();form.append('file',tempoFile);form.append('review',JSON.stringify({source_sha256:tempoPrediction.source_sha256,segments,meter}));
  const response=await fetch('/tempo/audition',{method:'POST',body:form}),data=await response.json();
  if(!response.ok)throw Error(data.detail);
  if(auditionURL)URL.revokeObjectURL(auditionURL);
  auditionURL=URL.createObjectURL(new Blob([Uint8Array.from(atob(data.audition_wav_base64),c=>c.charCodeAt(0))],{type:'audio/wav'}));
  $('countAudio').src=auditionURL;$('countAudio').hidden=false;
  const decoder=new AudioContext();try{const b=await decoder.decodeAudioData(Uint8Array.from(atob(data.audition_wav_base64),c=>c.charCodeAt(0)).buffer);reviewBuffers.click=b;drawReview('reviewClick',b,1);}finally{await decoder.close();}
  $('countAudio').currentTime=$('tempoAudio').currentTime;$('reviewPlay').textContent='Play song + click';$('clickHint').textContent='Song and click share one playback position.';
  auditionData=data;loopRange=null;$('loopStatus').textContent='Choose bars and set loop at playhead.';const actual=data.meter_review.first_one;$('reviewStack').style.setProperty('--one',(actual/tempoPrediction.duration*100)+'%');
  $('meterStatus').textContent='Unconfirmed '+meter.numerator+'/4 · ONE at '+actual.toFixed(3)+' s (snapped from '+meter.first_one.toFixed(3)+'). '+(meter.pattern==='332'?'3+3+2 eighth notes: accents on pulses 1, 4 and 7.':meter.pattern==='eighth'?'Eighth-note pulses; highest click starts each bar.':'Quarter-note pulses; highest click starts each bar.')+' Press play to listen.';updateReview();
 }catch(e){$('meterStatus').textContent=e.message;}finally{controls.forEach(c=>c.disabled=false);}
};

function reviewAudio(){return auditionURL?$('countAudio'):$('tempoAudio');}
function updateReview(){
 if(!tempoPrediction)return;
 const t=reviewPosition();
 $('reviewSeek').value=t;$('reviewTime').textContent=t.toFixed(1)+' / '+tempoPrediction.duration.toFixed(1)+' s';
 $('reviewStack').style.setProperty('--playhead',(t-view.start)/(view.end-view.start)*100+'%');
 const one=auditionData?.meter_review.first_one??Number($('firstOne').value||0);
 $('reviewStack').style.setProperty('--one',(one-view.start)/(view.end-view.start)*100+'%');
 for(const marker of $('reviewStack').querySelectorAll('.one-marker'))marker.hidden=one<view.start||one>view.end;

}
$('reviewPlay').onclick=async()=>{
 try{stopReviewLoop();const a=reviewAudio();if(a.paused)await a.play();else a.pause();}
 catch(e){$('status').textContent=e.message;}
};
$('reviewSeek').oninput=()=>{stopReviewLoop();reviewAudio().currentTime=Number($('reviewSeek').value);updateReview();};
for(const a of [$('tempoAudio'),$('countAudio')]){
 a.addEventListener('timeupdate',updateReview);
 a.addEventListener('play',()=>{$('reviewPlay').textContent='Pause';});
 a.addEventListener('pause',()=>{$('reviewPlay').textContent=auditionURL?'Play song + click':'Play original';});
 a.addEventListener('ended',updateReview);
}

$('zoom').onchange=()=>renderView();
$('zoomCenter').onclick=()=>renderView();
$('zoomBack').onclick=()=>renderView(view.start-(view.end-view.start)/2);
$('zoomNext').onclick=()=>renderView(view.end+(view.end-view.start)/2);
$('loopBars').onchange=()=>{stopReviewLoop();loopRange=null;$('loopStatus').textContent='Set loop again for the new bar count.';};
$('setLoop').onclick=()=>{
 try{
  if(!auditionData)throw Error('Build a count audition first.');
  const time=reviewPosition();stopReviewLoop();loopRange=null;
  loopRange=barLoop(auditionData.meter_review.pulse_times,auditionData.meter_review.first_one_pulse_index,auditionData.meter_review.pulses_per_cycle,Number($('loopBars').value),time);
  $('loopStatus').textContent=loopRange.bars+' complete cycles / bars · '+loopRange.start.toFixed(3)+'–'+loopRange.end.toFixed(3)+' s';
 }catch(e){$('loopStatus').textContent=e.message;}
};
$('playLoop').onclick=async()=>{
 try{
  if(!loopRange||!reviewBuffers.click)throw Error('Set a complete-bar loop first.');
  stopReviewLoop();if(playing)stop();$('tempoAudio').pause();$('countAudio').pause();
  loopContext??=new AudioContext();await loopContext.resume();
  loopSource=loopContext.createBufferSource();loopSource.buffer=reviewBuffers.click;loopSource.loop=true;
  loopSource.loopStart=loopRange.start;loopSource.loopEnd=loopRange.end;loopSource.connect(loopContext.destination);
  loopEpoch=loopContext.currentTime;loopSource.start(loopEpoch,loopRange.start);$('playLoop').textContent='Loop playing';
 }catch(e){$('loopStatus').textContent=e.message;}
};
$('stopLoop').onclick=()=>{const t=reviewPosition();stopReviewLoop();reviewAudio().currentTime=t;updateReview();};
function reviewTick(){if(loopSource)updateReview();requestAnimationFrame(reviewTick);}reviewTick();
