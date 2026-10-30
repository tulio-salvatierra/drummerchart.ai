import test from 'node:test';
import assert from 'node:assert/strict';
import {viewport,barLoop} from '../static/timeline.mjs';
test('zoom stays within song at either edge',()=>{
 assert.deepEqual(viewport(100,4,0),{start:0,end:25});
 assert.deepEqual(viewport(100,4,100),{start:75,end:100});
 assert.deepEqual(viewport(100,4,50),{start:37.5,end:62.5});
});
test('3/4 loops follow actual variable beat timing and pickup anchor',()=>{
 const beats=[0,.5,1,1.6,2.3,3,3.7,4.4,5.1,5.8,6.5];
 assert.deepEqual(barLoop(beats,1,3,2,1.2),{start:.5,end:4.4,bars:2});
 assert.deepEqual(barLoop(beats,1,3,1,2.4),{start:2.3,end:4.4,bars:1});
 assert.throws(()=>barLoop(beats,1,3,4,5));
});
test('3+3+2 loop covers eight pulses and respects eighth-note ONE',()=>{
 const pulses=Array.from({length:25},(_,i)=>i*.25);
 assert.deepEqual(barLoop(pulses,1,8,2,.9),{start:.25,end:4.25,bars:2});
 assert.throws(()=>barLoop(pulses,1,8,4,0));
});
