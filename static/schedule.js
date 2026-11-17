/* Click schedule for the in-browser preview. Mirrors schedule.py exactly:
   same rules, same sounds. tests/test_schedule_parity.py runs both and compares. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DCSchedule = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var KIND_ORDER = { count: 0, precue: 1, voice: 1, marker: 2, downbeat: 3, beat: 4, soft: 5 };

  // name: [frequency Hz, length s, amplitude]. Mirrors SOUNDS in schedule.py.
  var SOUNDS = {
    beat: [1200.0, 0.045, 0.55],
    downbeat: [1800.0, 0.05, 0.75],
    soft: [1200.0, 0.035, 0.28],
    count: [1500.0, 0.045, 0.6],
    precue: [520.0, 0.18, 0.9],
    marker: [2400.0, 0.06, 0.85],
  };
  var DECAY = 28.0;

  var LOUD = 0, NORMAL = 1, SOFT = 2, OFF = 3;
  var LEVEL_KIND = ["downbeat", "beat", "soft"];

  function beatsPerBar(meter) {
    var n = parseInt(String(meter).split("/")[0], 10);
    return Number.isInteger(n) && n >= 1 && n <= 32 ? n : 4;
  }

  function defaultAccents(n) {
    var out = [];
    for (var i = 0; i < n; i++) {
      if (n === 6 || n === 9 || n === 12) out.push(i === 0 ? LOUD : i % 3 === 0 ? NORMAL : SOFT);
      else out.push(i === 0 ? LOUD : NORMAL);
    }
    return out;
  }

  function accentsFor(settings, n) {
    var custom = (settings.accents || {})[String(n)];
    if (Array.isArray(custom) && custom.length === n &&
        custom.every(function (v) { return v === 0 || v === 1 || v === 2 || v === 3; })) {
      return custom.slice();
    }
    return defaultAccents(n);
  }

  function applyGrid(beats, grid) {
    var out = [], i;
    if (grid === "half") {
      for (i = 0; i < beats.length; i += 2) out.push(beats[i]);
      return out;
    }
    if (grid === "double") {
      for (i = 0; i < beats.length; i++) {
        out.push(beats[i]);
        if (i + 1 < beats.length) out.push((beats[i] + beats[i + 1]) / 2.0);
      }
      return out;
    }
    return beats.slice();
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
      .sort(function (a, b) { return Number(a.m.time) - Number(b.m.time) || a.i - b.i; })
      .map(function (x) { return x.m; });
    var resolved = [];
    ordered.forEach(function (m) {
      var entry = {
        index: nearestBeatIndex(beats, Number(m.time)),
        beatsPerBar: beatsPerBar(m.meter === undefined ? "4/4" : m.meter),
        voice: m.voice || null,
      };
      if (resolved.length && resolved[resolved.length - 1].index === entry.index) resolved[resolved.length - 1] = entry;
      else resolved.push(entry);
    });
    if (!resolved.length) resolved = [{ index: 0, beatsPerBar: 4, voice: null }];
    return resolved;
  }

  function median(values) {
    var s = values.slice().sort(function (a, b) { return a - b; });
    var mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2.0;
  }

  function normalize(settings) {
    var s = { count_in_bars: 1, grid: "normal", accents: {} };
    if (settings && typeof settings === "object") {
      ["count_in_bars", "grid", "accents"].forEach(function (k) { if (k in settings) s[k] = settings[k]; });
    }
    if ([0, 1, 2].indexOf(s.count_in_bars) < 0) s.count_in_bars = 1;
    if (["normal", "half", "double"].indexOf(s.grid) < 0) s.grid = "normal";
    if (!s.accents || typeof s.accents !== "object" || Array.isArray(s.accents)) s.accents = {};
    return s;
  }

  function buildClickSchedule(beats, markers, duration, settings) {
    settings = normalize(settings);
    beats = applyGrid(beats.map(Number), settings.grid);
    duration = Number(duration);
    if (!beats.length) return [];
    var sections = resolveMarkers(beats, markers);
    var one = sections[0].index, n0 = sections[0].beatsPerBar;
    var events = [];
    var i, k;

    var interval = 0;
    if (beats.length >= 2) {
      var start = Math.min(one, beats.length - 2);
      var span = Math.min(4, beats.length - 1 - start);
      var gaps = [];
      for (i = start; i < start + span; i++) gaps.push(beats[i + 1] - beats[i]);
      interval = median(gaps);
    }
    function timeAt(index) { return index >= 0 ? beats[index] : beats[0] + index * interval; }

    var covered = {};
    if (interval > 0) {
      var bars = settings.count_in_bars;
      while (bars > 0 && timeAt(one - bars * n0) < 0) bars--;
      for (var j = bars * n0; j > 0; j--) {
        var idx = one - j;
        events.push({ time: timeAt(idx), kind: "count" });
        if (idx >= 0) covered[idx] = true;
      }
    }

    var accentCache = {};
    k = 0;
    for (i = 0; i < beats.length; i++) {
      var t = beats[i];
      if (i < one) {
        if (!covered[i]) events.push({ time: t, kind: "beat" });
        continue;
      }
      while (k + 1 < sections.length && sections[k + 1].index <= i) k++;
      var sec = sections[k];
      if (i === sec.index && k > 0) { events.push({ time: t, kind: "marker" }); continue; }
      var n = sec.beatsPerBar;
      if (!accentCache[n]) accentCache[n] = accentsFor(settings, n);
      var level = accentCache[n][(i - sec.index) % n];
      if (level !== OFF) events.push({ time: t, kind: LEVEL_KIND[level] });
    }

    for (k = 0; k < sections.length; k++) {
      if (k === 0) {
        if (sections[0].voice && interval > 0) {
          var tv = timeAt(one - n0);
          if (tv >= 0) events.push({ time: tv, kind: "voice", note: sections[0].voice });
        }
        continue;
      }
      var index = sections[k].index - sections[k - 1].beatsPerBar;
      if (index < 0) continue;
      if (sections[k].voice) events.push({ time: beats[index], kind: "voice", note: sections[k].voice });
      else events.push({ time: beats[index], kind: "precue" });
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
    applyGrid: applyGrid,
    accentsFor: accentsFor,
    defaultAccents: defaultAccents,
    SOUNDS: SOUNDS,
    DECAY: DECAY,
    LEVELS: ["Loud", "Normal", "Soft", "Off"],
  };
});
