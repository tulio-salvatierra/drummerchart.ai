export function initialChart(result) {
  const edges = [0, ...result.boundary_times.filter(t => t > 0 && t < result.duration), result.duration];
  return edges.slice(0, -1).map((start, i) => ({start, end: edges[i+1], label: 'Unknown', confirmed: false}));
}
export function snap(time, beats, enabled) {
  return enabled && beats.length ? beats.reduce((a,b) => Math.abs(b-time)<Math.abs(a-time)?b:a) : time;
}
export function move(sections, index, time) {
  if (!Number.isFinite(time) || index < 1 || index >= sections.length ||
      time <= sections[index-1].start || time >= sections[index].end) throw Error('Boundary must stay between neighboring boundaries.');
  sections[index-1].end = sections[index].start = time;
  sections[index-1].confirmed = sections[index].confirmed = false;
}
export function split(sections, index, time) {
  const s = sections[index];
  if (!Number.isFinite(time) || time <= s.start || time >= s.end) throw Error('Seek inside the selected section before splitting.');
  sections.splice(index, 1, {...s,end:time,confirmed:false}, {...s,start:time,confirmed:false});
}
export function merge(sections,index) {
  if (index >= sections.length-1) throw Error('Select a section with a following section.');
  sections.splice(index,2,{...sections[index],end:sections[index+1].end,confirmed:false});
}
export function exportChart(result, predicted, sections) {
  const {click_wav_base64, ...metadata} = result;
  return {...metadata, exported_at:new Date().toISOString(), predicted_sections:predicted,
    corrected_sections:sections.map(s=>({...s,label_status:s.confirmed?'user-confirmed':'unconfirmed'})),
    training_performed:false};
}
