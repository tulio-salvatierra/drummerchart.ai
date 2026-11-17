/* Click schedule for the in-browser preview. Mirrors schedule.py exactly:
   same rules, same sounds. tests/test_schedule_parity.py runs both and compares. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DCSchedule = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var KIND_ORDER = { count: 0, precue: 1, marker: 2, downbeat: 3, beat: 4 };

  // name: [frequency Hz, length s, amplitude]. Mirrors SOUNDS in schedule.py.
  var SOUNDS = {
    beat: [1200.0, 0.045, 0.55],
    downbeat: [1800.0, 0.05, 0.75],
    count: [1500.0, 0.045, 0.6],
    precue: [520.0, 0.18, 0.9],
    marker: [2400.0, 0.06, 0.85],
  };
  var DECAY = 28.0;

  function beatsPerBar(meter) {
    var n = parseInt(String(meter).split("/")[0], 10);
    return Number.isInteger(n) && n >= 1 && n <= 32 ? n : 4;
  }

  function nearestBeatIndex(beats, time) {
    var lo = 0, hi = beats.length - 1;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (beats[mid] < time) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0 && Math.abs(beats[lo - 1] - time) <= Math.abs(beats[lo] - time)) return lo - 1;
    return lo;
  }

  function resolveMarkers(beats, markers) {
    var ordered = markers
      .map(function (m, i) { return { m: m, i: i }; })
      .sort(function (a, b) { return a.m.time - b.m.time || a.i - b.i; })
      .map(function (x) { return x.m; });
    var resolved = [];
    ordered.forEach(function (m, i) {
      var index = i === 0 ? 0 : nearestBeatIndex(beats, Number(m.time));
      var entry = { index: index, beatsPerBar: beatsPerBar(m.meter === undefined ? "4/4" : m.meter) };
      if (resolved.length && resolved[resolved.length - 1].index === index) resolved[resolved.length - 1] = entry;
      else resolved.push(entry);
    });
    if (!resolved.length) resolved = [{ index: 0, beatsPerBar: 4 }];
    return resolved;
  }

  function median(values) {
    var s = values.slice().sort(function (a, b) { return a - b; });
    var mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2.0;
  }

  function buildClickSchedule(beats, markers, duration) {
    beats = beats.map(Number);
    duration = Number(duration);
    if (!beats.length) return [];
    var sections = resolveMarkers(beats, markers);
    var events = [];
    var i, k;

    if (beats.length >= 2) {
      var n0 = sections[0].beatsPerBar;
      var span = Math.min(4, beats.length - 1);
      var gaps = [];
      for (i = 0; i < span; i++) gaps.push(beats[i + 1] - beats[i]);
      var interval = median(gaps);
      if (interval > 0 && beats[0] - n0 * interval >= 0) {
        for (var j = n0; j > 0; j--) events.push({ time: beats[0] - j * interval, kind: "count" });
      }
    }

    k = 0;
    for (i = 0; i < beats.length; i++) {
      while (k + 1 < sections.length && sections[k + 1].index <= i) k++;
      var sec = sections[k];
      var kind;
      if (i === sec.index && k > 0) kind = "marker";
      else if ((i - sec.index) % sec.beatsPerBar === 0) kind = "downbeat";
      else kind = "beat";
      events.push({ time: beats[i], kind: kind });
    }

    for (k = 1; k < sections.length; k++) {
      var index = sections[k].index - sections[k - 1].beatsPerBar;
      if (index >= 0) events.push({ time: beats[index], kind: "precue" });
    }

    events = events.filter(function (e) { return e.time >= 0 && e.time <= duration; });
    events.sort(function (a, b) { return a.time - b.time || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]; });
    return events;
  }

  return {
    buildClickSchedule: buildClickSchedule,
    resolveMarkers: resolveMarkers,
    nearestBeatIndex: nearestBeatIndex,
    beatsPerBar: beatsPerBar,
    SOUNDS: SOUNDS,
    DECAY: DECAY,
  };
});
