export function viewport(duration, zoom, center) {
 const width=duration/zoom;
 const start=Math.max(0,Math.min(duration-width,center-width/2));
 return {start,end:start+width};
}
export function barLoop(beats, firstIndex, meter, bars, time) {
 if(![1,2,4,8].includes(bars))throw Error('Choose 1, 2, 4 or 8 bars.');
 let index=firstIndex;
 while(index+meter<beats.length && beats[index+meter]<=time)index+=meter;
 const endIndex=index+meter*bars;
 if(endIndex>=beats.length)throw Error('Not enough detected beats for complete bars here. Move earlier.');
 return {start:beats[index],end:beats[endIndex],bars};
}
