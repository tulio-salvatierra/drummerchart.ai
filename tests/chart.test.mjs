import test from 'node:test';
import assert from 'node:assert/strict';
import {initialChart,snap,move,split,merge,exportChart} from '../static/chart.mjs';
const result={duration:12,beat_times:[1,2,3,4,5,6,7,8,9,10,11],boundary_times:[6],click_wav_base64:'omit'};
test('edits preserve coverage and invalidate confirmation',()=>{
 const s=initialChart(result);s.forEach(x=>x.confirmed=true);
 move(s,1,snap(7.2,result.beat_times,true));assert.equal(s[0].end,7);assert.equal(s[1].start,7);assert.equal(s[0].confirmed,false);
 split(s,0,3);assert.equal(s.length,3);merge(s,0);assert.equal(s.length,2);assert.equal(s[0].start,0);assert.equal(s.at(-1).end,12);
 assert.throws(()=>move(s,1,12));assert.throws(()=>split(s,0,0));assert.throws(()=>merge(s,1));assert.throws(()=>move(s,1,NaN));
});
test('export preserves predictions separately and excludes audio',()=>{
 const p=initialChart(result),s=structuredClone(p);s[0].label='Intro';s[0].confirmed=true;
 const out=exportChart(result,p,s);assert.equal(out.predicted_sections[0].label,'Unknown');assert.equal(out.corrected_sections[0].label_status,'user-confirmed');assert.equal(out.corrected_sections[1].label_status,'unconfirmed');assert.equal(out.click_wav_base64,undefined);assert.equal(out.training_performed,false);
 assert.equal(snap(2.4,[],true),2.4);assert.equal(snap(2.4,[2],false),2.4);
});
