/* Drummer Chart AI — the one-page app.
   Upload, edit, practice and download on the same page. Vanilla JS, no build step.
   The click schedule comes from schedule.js (DCSchedule): the same rules the server
   uses to render the WAVs, so the preview and the download match. */
(function () {
  "use strict";

  var S = window.DCSchedule;
  var $ = function (id) { return document.getElementById(id); };
  var body = document.body;
  var audio = $("audio");

  var MAX_BYTES = 20 * 1024 * 1024;
  var PAD = 18, RULER = 24, GRID_H = 40;
  var VOICE_MAX = 6.0;

  /* =========================================================== helpers */
  function fmtTime(t, tenths) {
    t = Math.max(0, t || 0);
    var m = Math.floor(t / 60), s = t - m * 60;
    var whole = tenths ? s.toFixed(1) : String(Math.floor(s));
    if (parseFloat(whole) < 10) whole = "0" + whole;
    return m + ":" + whole;
  }
  function lowerBound(arr, t) {
    var lo = 0, hi = arr.length;
    while (lo < hi) { var mid = (lo + hi) >> 1; if (arr[mid] < t) lo = mid + 1; else hi = mid; }
    return lo;
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function showError(msg) { $("error").textContent = msg || ""; $("error").hidden = !msg; }
  function isChorus(label) { return /chorus|coro|estribillo/i.test(label || ""); }

  /* =========================================================== upload */
  var dropzone = $("dropzone"), fileInput = $("file-input");
  var busyTimer = null;

  function uploadFail(message) {
    clearInterval(busyTimer);
    dropzone.classList.remove("busy");
    $("drop-error").textContent = message;
    $("drop-error").hidden = false;
    fileInput.value = "";
  }

  function startUpload(file) {
    $("drop-error").hidden = true;
    if (!file) return;
    if (!/\.mp3$/i.test(file.name)) return uploadFail("Only MP3 files work for now.");
    if (file.size > MAX_BYTES) return uploadFail("That file is over 20 MB. Try a smaller MP3.");
    dropzone.classList.add("busy");
    $("busy-name").textContent = file.name;
    var started = Date.now();
    var tickBusy = function () {
      var s = (Date.now() - started) / 1000;
      $("busy-fill").style.width = Math.min(94, (s / 40) * 100) + "%";
      $("busy-status").textContent = (s < 4 ? "Uploading…" : s < 14 ? "Finding the beat…" : s < 26 ? "Finding sections…" : "Guessing time signatures…") + " " + Math.round(s) + " s";
    };
    tickBusy();
    busyTimer = setInterval(tickBusy, 500);
    var data = new FormData();
    data.append("file", file);
    fetch("/analyze", { method: "POST", body: data })
      .then(function (res) {
        if (res.ok && res.redirected) {
          var id = res.url.split("/").pop();
          clearInterval(busyTimer);
          $("busy-fill").style.width = "100%";
          history.pushState({ job: id }, "", "/job/" + id);
          return loadJob(id).then(function () {
            dropzone.classList.remove("busy");
            fileInput.value = "";
          });
        }
        return res.json().then(
          function (b) { uploadFail(b.detail || "Something went wrong. Try another file."); },
          function () { uploadFail("Something went wrong (" + res.status + "). Try another file."); }
        );
      })
      .catch(function () { uploadFail("Could not reach the server. Is it still running?"); });
  }

  fileInput.addEventListener("change", function () { startUpload(fileInput.files[0]); });
  ["dragenter", "dragover"].forEach(function (type) {
    document.addEventListener(type, function (e) {
      e.preventDefault();
      if (!body.classList.contains("has-job")) dropzone.classList.add("over");
    });
  });
  ["dragleave", "drop"].forEach(function (type) {
    document.addEventListener(type, function (e) { e.preventDefault(); dropzone.classList.remove("over"); });
  });
  document.addEventListener("drop", function (e) {
    if (body.classList.contains("has-job") || dropzone.classList.contains("busy")) return;
    if (e.dataTransfer && e.dataTransfer.files.length) startUpload(e.dataTransfer.files[0]);
  });

  function goHome(push) {
    audio.pause();
    if (rec) rec.stop();
    body.classList.remove("has-job", "practicing");
    job = null;
    if (push) history.pushState({}, "", "/");
    document.title = "Drummer Chart AI — charts that count themselves in";
    window.scrollTo(0, 0);
  }
  $("new-song").addEventListener("click", function () { goHome(true); });
  $("logo-home").addEventListener("click", function (e) { e.preventDefault(); goHome(true); });
  window.addEventListener("popstate", function () {
    var m = location.pathname.match(/^\/job\/([0-9a-f]{32})$/);
    if (m) loadJob(m[1]); else goHome(false);
  });

  /* =========================================================== state */
  var job = null;               // analysis JSON
  var rawBeats = [], beats = [], duration = 0, detected = [];
  var markers = [];             // {id, i, meter, label, conf, auto, voice}
  var settings = { count_in_bars: 1, grid: "normal", accents: {} };
  var nextId = 1, selectedId = null;
  var undoStack = [], redoStack = [];
  var sections = [], secInfo = [], schedule = [], barLines = [];
  var storeKey = "";
  var view = "edit", listen = "both", loopOn = false, loopSec = null;
  var zoom = 1, viewW = 0, viewH = 0, pxPerSec = 1;
  var peaks = null, peaksRate = 100;
  var voiceBuffers = {}, voiceLoading = {};

  function sorted() { return markers.slice().sort(function (a, b) { return a.i - b.i; }); }
  function find(id) { for (var k = 0; k < markers.length; k++) if (markers[k].id === id) return markers[k]; return null; }
  function theOne() { return sorted()[0]; }
  function occupied(i, exceptId) { return markers.some(function (m) { return m.i === i && m.id !== exceptId; }); }
  function exportMarkers() {
    return sorted().map(function (m) {
      var out = { time: beats[m.i], meter: m.meter, label: m.label };
      if (m.voice) out.voice = m.voice;
      return out;
    });
  }
  function snapshot() { return JSON.stringify({ markers: markers, settings: settings, selectedId: selectedId }); }
  function restore(snap) {
    var s = JSON.parse(snap);
    var gridChanged = s.settings.grid !== settings.grid;
    markers = s.markers; settings = s.settings;
    if (gridChanged) beats = S.applyGrid(rawBeats, settings.grid);
    selectedId = find(s.selectedId) ? s.selectedId : null;
    nextId = markers.reduce(function (n, m) { return Math.max(n, m.id + 1); }, 1);
  }
  function pushUndo(snap) {
    undoStack.push(snap || snapshot());
    if (undoStack.length > 200) undoStack.shift();
    redoStack.length = 0;
  }
  function undo() { if (!undoStack.length) return; redoStack.push(snapshot()); restore(undoStack.pop()); closePopover(); changed(); }
  function redo() { if (!redoStack.length) return; undoStack.push(snapshot()); restore(redoStack.pop()); closePopover(); changed(); }

  function buildSections() {
    var list = sorted();
    sections = S.resolveMarkers(beats, exportMarkers());
    secInfo = list.map(function (m, k) {
      var endI = k + 1 < list.length ? list[k + 1].i : beats.length;
      return {
        marker: m, index: m.i, endIndex: endI, bpb: S.beatsPerBar(m.meter), meter: m.meter,
        startT: beats[m.i], endT: k + 1 < list.length ? beats[list[k + 1].i] : duration,
        label: m.label || (k === 0 ? "Start" : "Section " + (k + 1)),
        low: m.auto && m.conf !== null && m.conf < 0.5,
      };
    });
    barLines = [];
    secInfo.forEach(function (s) { for (var i = s.index; i < s.endIndex; i += s.bpb) barLines.push(i); });
  }
  function sectionAtIndex(i) {
    var k = 0;
    while (k + 1 < secInfo.length && secInfo[k + 1].index <= i) k++;
    return k;
  }
  function beatAtOrBefore(t) { return Math.max(0, lowerBound(beats, t + 1e-6) - 1); }

  function changed(opts) {
    buildSections();
    schedule = S.buildClickSchedule(rawBeats, exportMarkers(), duration, settings);
    resync();
    if (loopOn && loopSec) loopSec = findLoopSec();
    if (!opts || !opts.transient) {
      try { localStorage.setItem(storeKey, JSON.stringify({ markers: markers, settings: settings })); } catch (e) { /* private mode */ }
      markStale();
    }
    $("undo").disabled = !undoStack.length;
    $("redo").disabled = !redoStack.length;
    renderMarkers(); renderMap(); renderAccents(); renderCountIn(); renderSongInfo();
    requestDraw();
  }
  function findLoopSec() {
    // Keep looping the section that starts at the same beat, if it still exists.
    for (var k = 0; k < secInfo.length; k++) if (secInfo[k].index === loopSec.index) return secInfo[k];
    return secInfo[sectionAtIndex(beatAtOrBefore(songTime()))];
  }

  /* =========================================================== editing */
  function meterAt(i) { return secInfo.length ? secInfo[sectionAtIndex(i)].meter : "4/4"; }
  function addMarkerAt(time) {
    var i = S.nearestBeatIndex(beats, time), one = theOne();
    if (i <= one.i) i = one.i + 1;
    if (i >= beats.length) return;
    var existing = markers.filter(function (x) { return x.i === i; })[0];
    if (existing) { selectedId = existing.id; renderMarkers(); if (audio.paused) openPopover(existing.id); return; }
    pushUndo();
    var m = { id: nextId++, i: i, meter: meterAt(i), label: "", conf: null, auto: false, voice: null };
    markers.push(m);
    selectedId = m.id;
    changed();
    if (audio.paused) openPopover(m.id); else closePopover();
  }
  function removeMarker(id) {
    var m = find(id);
    if (!m || m.id === theOne().id) return;
    pushUndo();
    markers = markers.filter(function (x) { return x.id !== id; });
    selectedId = null; closePopover(); changed();
  }
  function setMeter(id, meter) {
    var m = find(id);
    if (!m) return;
    if (m.meter === meter) { if (m.auto) { pushUndo(); m.auto = false; changed(); renderPopover(); } return; }
    pushUndo();
    m.meter = meter; m.auto = false;
    changed(); renderPopover();
  }
  function moveMarker(id, i) {
    var m = find(id), list = sorted();
    if (!m) return false;
    if (m.id === list[0].id) {
      var limit = list.length > 1 ? list[1].i - 1 : beats.length - 1;
      i = clamp(i, 0, limit);
    } else {
      i = clamp(i, list[0].i + 1, beats.length - 1);
    }
    if (i === m.i || occupied(i, id)) return false;
    m.i = i;
    return true;
  }
  function setGrid(grid) {
    if (grid === settings.grid) return;
    pushUndo();
    var next = S.applyGrid(rawBeats, grid);
    var seen = {};
    markers = sorted().filter(function (m) {
      m.i = S.nearestBeatIndex(next, beats[m.i]);
      if (seen[m.i]) return false;
      seen[m.i] = true;
      return true;
    });
    settings.grid = grid;
    beats = next;
    changed();
  }

  /* =========================================================== lane layout + canvas */
  var frame = $("frame"), canvas = $("lane"), scroller = $("scroller"), inner = $("inner");
  var playheadEl = $("playhead"), markersEl = $("markers"), popover = $("popover");
  var g = canvas.getContext("2d");
  var drawQueued = false;

  function timeToX(t) { return PAD + t * pxPerSec; }
  function xToTime(x) { return (x - PAD) / pxPerSec; }

  function layout() {
    if (!job || frame.offsetParent === null) return;
    viewW = frame.clientWidth; viewH = frame.clientHeight;
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(viewW * dpr); canvas.height = Math.round(viewH * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    var total = Math.max(viewW, Math.round(viewW * zoom));
    inner.style.width = total + "px";
    pxPerSec = (total - 2 * PAD) / Math.max(duration, 0.001);
    renderMarkers(); requestDraw(); positionPopover();
  }
  function requestDraw() {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(function () { drawQueued = false; draw(); });
  }
  function draw() {
    if (!job || !viewW) return;
    var w = viewW, h = viewH, sl = scroller.scrollLeft;
    var t0 = xToTime(sl - 4), t1 = xToTime(sl + w + 4);
    var now = songTime();
    g.clearRect(0, 0, w, h);

    // Section tints, pickup zone, cue bars.
    var one = secInfo.length ? secInfo[0].startT : 0;
    g.fillStyle = "#252a2c";
    g.fillRect(timeToX(0) - sl, RULER, timeToX(one) - timeToX(0), h - RULER);
    secInfo.forEach(function (s, k) {
      var xs = timeToX(s.startT) - sl, xe = timeToX(s.endT) - sl;
      if (xe < 0 || xs > w) return;
      g.fillStyle = isChorus(s.label) ? "rgba(50,113,240,0.14)" : (k % 2 ? "#282c2e" : "#1f1b1b");
      g.fillRect(xs, RULER, xe - xs, h - RULER);
    });
    var counts = schedule.filter(function (e) { return e.kind === "count"; });
    if (counts.length) {
      var cs = timeToX(counts[0].time) - sl, ce = timeToX(one) - sl;
      g.save();
      g.beginPath(); g.rect(cs, RULER, ce - cs, h - RULER - GRID_H); g.clip();
      g.strokeStyle = "rgba(75,239,5,0.10)"; g.lineWidth = 6;
      for (var sx = cs - h; sx < ce; sx += 16) { g.beginPath(); g.moveTo(sx, h); g.lineTo(sx + h, RULER); g.stroke(); }
      g.restore();
      if (ce - cs > 70) { g.fillStyle = "#4bef05"; g.font = "600 11px 'IBM Plex Sans', sans-serif"; g.fillText("COUNT-IN", cs + 6, RULER + 16); }
    }
    schedule.forEach(function (e) {
      if (e.kind !== "precue" && e.kind !== "voice") return;
      var k = sectionAtIndex(beatAtOrBefore(e.time + 0.001));
      var target = e.time < one ? one : (secInfo[k + 1] ? secInfo[k + 1].startT : e.time);
      var xs = timeToX(e.time) - sl, xe = timeToX(target) - sl;
      if (xe < 0 || xs > w) return;
      g.fillStyle = "rgba(75,239,5,0.10)";
      g.fillRect(xs, RULER, xe - xs, h - RULER - GRID_H);
      if (xe - xs > 46) {
        g.fillStyle = "#4bef05"; g.font = "600 11px 'IBM Plex Sans', sans-serif";
        g.fillText(e.kind === "voice" ? "VOICE CUE" : "CUE", xs + 6, h - GRID_H - 8);
      }
    });

    // Waveform.
    var mid = RULER + (h - RULER - GRID_H) / 2 + 6, amp = (h - RULER - GRID_H) / 2 - 18;
    if (peaks) {
      var step = 2;
      for (var x = Math.max(0, Math.floor(timeToX(0) - sl)); x < Math.min(w, timeToX(duration) - sl); x += step) {
        var ta = xToTime(x + sl), tb = xToTime(x + sl + step);
        var a = Math.max(0, Math.floor(ta * peaksRate)), b = Math.min(peaks.length, Math.ceil(tb * peaksRate));
        var p = 0;
        for (var q = a; q < b; q++) if (peaks[q] > p) p = peaks[q];
        if (a >= peaks.length) break;
        var hh = Math.max(1, p * amp);
        g.fillStyle = ta < now ? "#3271f0" : "#4f575a";
        g.fillRect(x, mid - hh, step - 0.6, hh * 2);
      }
    } else {
      g.fillStyle = "#a8a49c"; g.font = "13px 'IBM Plex Sans', sans-serif";
      g.fillText("Drawing waveform…", 16, mid);
    }

    // Ruler.
    g.fillStyle = "#1a1717"; g.fillRect(0, 0, w, RULER);
    var steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120], tick = 300;
    for (var si = 0; si < steps.length; si++) if (steps[si] * pxPerSec >= 70) { tick = steps[si]; break; }
    g.font = "500 11px 'IBM Plex Mono', monospace"; g.fillStyle = "#a8a49c"; g.strokeStyle = "#3d4346"; g.lineWidth = 1;
    for (var t = Math.max(0, Math.floor(t0 / tick) * tick); t <= Math.min(duration, t1); t += tick) {
      var xr = Math.round(timeToX(t) - sl) + 0.5;
      g.beginPath(); g.moveTo(xr, RULER - 6); g.lineTo(xr, RULER); g.stroke();
      g.fillText(fmtTime(t, tick < 1), xr + 4, 15);
    }

    // Beat grid.
    var gy = h - GRID_H;
    g.strokeStyle = "#3d4346"; g.beginPath(); g.moveTo(0, gy + 0.5); g.lineTo(w, gy + 0.5); g.stroke();
    counts.forEach(function (e) {
      var xc = Math.round(timeToX(e.time) - sl) + 0.5;
      if (xc < -2 || xc > w + 2) return;
      g.strokeStyle = "rgba(75,239,5,0.7)"; g.setLineDash([3, 3]);
      g.beginPath(); g.moveTo(xc, gy + 14); g.lineTo(xc, h); g.stroke(); g.setLineDash([]);
    });
    var gap = beats.length > 1 ? (beats[beats.length - 1] - beats[0]) / (beats.length - 1) * pxPerSec : 10;
    var first = Math.max(0, lowerBound(beats, t0)), kk = 0;
    for (var i = first; i < beats.length && beats[i] <= t1; i++) {
      var xb = Math.round(timeToX(beats[i]) - sl) + 0.5;
      if (!secInfo.length || i < secInfo[0].index) {
        if (gap >= 4) { g.strokeStyle = "rgba(208,204,196,0.25)"; g.beginPath(); g.moveTo(xb, gy + 22); g.lineTo(xb, h); g.stroke(); }
        continue;
      }
      while (kk + 1 < secInfo.length && secInfo[kk + 1].index <= i) kk++;
      var sec = secInfo[kk], pos = (i - sec.index) % sec.bpb;
      if (pos === 0) {
        var bar = (i - sec.index) / sec.bpb, barGap = gap * sec.bpb;
        var skip = barGap >= 5 ? 1 : barGap >= 2.5 ? 2 : 4;
        if (bar % skip) continue;
        g.strokeStyle = "#bdb9b1"; g.lineWidth = barGap >= 9 ? 1.5 : 1;
        g.beginPath(); g.moveTo(xb, gy + 4); g.lineTo(xb, h); g.stroke(); g.lineWidth = 1;
        var every = barGap >= 28 ? 1 : barGap >= 14 ? 2 : barGap >= 7 ? 4 : 8;
        if (bar % every === 0) { g.fillStyle = "#a8a49c"; g.font = "500 10px 'IBM Plex Mono', monospace"; g.fillText(String(bar + 1), xb + 3, gy + 14); }
      } else if (gap >= 4) {
        g.strokeStyle = "#4f575a"; g.beginPath(); g.moveTo(xb, gy + 22); g.lineTo(xb, h); g.stroke();
      }
    }
  }

  /* =========================================================== markers (DOM) */
  var markerEls = {};
  var micSvg = '<svg viewBox="0 0 24 24" role="img" aria-label="voice cue"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/></svg>';
  function renderMarkers() {
    if (!job) return;
    var seen = {}, list = sorted(), lastX = [-1e9, -1e9];
    list.forEach(function (m, k) {
      var el = markerEls[m.id];
      if (!el) {
        el = document.createElement("button");
        el.type = "button";
        el.innerHTML = '<span class="flag"></span>';
        el.dataset.id = m.id;
        markersEl.appendChild(el);
        markerEls[m.id] = el;
      }
      seen[m.id] = true;
      var isOne = k === 0;
      var x = timeToX(beats[m.i]);
      var low = m.auto && m.conf !== null && m.conf < 0.5;
      var row = x - lastX[0] >= 120 ? 0 : x - lastX[1] >= 120 ? 1 : 0;
      lastX[row] = x;
      el.style.transform = "translateX(" + x + "px)";
      el.className = "marker row-" + row + (isOne ? " one" : "") + (low ? " low" : "") +
        (m.id === selectedId ? " selected" : "") + (drag && drag.id === m.id && drag.moved ? " dragging" : "");
      var key = [isOne, m.meter, m.label, low, !!m.voice].join("|");
      var flag = el.firstChild;
      if (flag.dataset.k !== key) {
        flag.dataset.k = key;
        var html = isOne ? '<span class="num">1</span>' : "";
        html += '<span class="mt"></span>';
        if (m.label) html += '<span class="lb"></span>';
        if (m.voice) html += micSvg;
        flag.innerHTML = html;
        flag.querySelector(".mt").textContent = m.meter + (low ? " ?" : "");
        if (m.label) flag.querySelector(".lb").textContent = m.label;
      }
      el.setAttribute("aria-label", (isOne ? "The one, first downbeat, at " : "Marker at ") + fmtTime(beats[m.i], true) + ", " + m.meter +
        (m.label ? ", " + m.label : "") + (m.voice ? ", with voice cue" : "") + (low ? ", time signature unsure" : ""));
      el.title = isOne ? "The 1: drag onto the first downbeat" : low ? "Unsure time signature: click to check it" : "Drag to move · click to edit";
    });
    Object.keys(markerEls).forEach(function (id) {
      if (!seen[id]) { markerEls[id].remove(); delete markerEls[id]; }
    });
  }

  /* =========================================================== popover + voice */
  function openPopover(id) { selectedId = id; popover.hidden = false; renderMarkers(); renderPopover(); positionPopover(); renderAccents(); }
  function closePopover() { if (rec) rec.stop(); popover.hidden = true; }
  function renderPopover() {
    var m = find(selectedId);
    if (!m) return closePopover();
    var isOne = m.id === theOne().id;
    Array.prototype.forEach.call($("meters").children, function (b) { b.classList.toggle("active", b.dataset.meter === m.meter); });
    if (document.activeElement !== $("label")) $("label").value = m.label;
    $("pop-one").hidden = !isOne;
    $("delete-marker").disabled = isOne;
    $("delete-marker").title = isOne ? "The 1 can't be deleted. Drag it instead." : "Delete marker (Delete)";
    var conf = $("confidence");
    if (m.auto && m.conf !== null) conf.textContent = (m.conf < 0.5 ? "Unsure guess, defaults to 4/4 · " : "Auto-detected · ") + "confidence " + Math.round(m.conf * 100) + "%";
    else conf.textContent = "Set by you";
    renderVoice(m, isOne);
  }
  function cueBarSeconds(m) {
    var list = sorted(), k = list.indexOf(m);
    var bpb = S.beatsPerBar(k > 0 ? list[k - 1].meter : m.meter);
    var i = m.i, span = Math.min(4, beats.length - 1 - Math.max(0, i - 4));
    var a = Math.max(0, i - 4), interval = (beats[Math.min(beats.length - 1, a + span)] - beats[a]) / Math.max(1, span);
    return bpb * interval;
  }
  function renderVoice(m, isOne) {
    var has = !!m.voice;
    $("voice-has").hidden = !has;
    $("voice-remove").hidden = !has || !!rec;
    var hint = $("voice-hint");
    hint.classList.remove("warn");
    if (rec) {
      hint.textContent = "Recording… press Stop when you're done (6 s max).";
    } else if (has) {
      var buf = voiceBuffers[m.voice];
      var len = buf ? buf.duration : 0;
      $("voice-len").textContent = buf ? len.toFixed(1) + " s" : "…";
      drawVoiceWave(buf);
      var bar = cueBarSeconds(m);
      if (buf && len > bar + 0.05) {
        hint.classList.add("warn");
        hint.textContent = "This cue is " + len.toFixed(1) + " s but the bar before the change is " + bar.toFixed(1) + " s, so it runs into the " + (isOne ? "1" : "change") + ". Try a shorter one.";
      } else {
        hint.textContent = isOne ? "Plays one bar before the 1 (if the song has room)." : "Plays one bar before this marker, instead of the cue tone.";
      }
    } else {
      hint.textContent = "Record a cue, like “Chorus, Metallica”. It plays one bar before " + (isOne ? "the 1." : "this marker.");
    }
    if (!rec) $("voice-record-label").textContent = has ? "Re-record" : "Record cue";
  }
  function drawVoiceWave(buf) {
    var c = $("voice-wave"), ctx2 = c.getContext("2d");
    var w = c.clientWidth || 200, h = 28, dpr = window.devicePixelRatio || 1;
    c.width = w * dpr; c.height = h * dpr; ctx2.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx2.clearRect(0, 0, w, h);
    if (!buf) return;
    var data = buf.getChannelData(0), n = Math.floor(w / 3), per = Math.floor(data.length / n), peak = 0, vals = [];
    for (var k = 0; k < n; k++) {
      var p = 0;
      for (var j = k * per; j < (k + 1) * per; j += 8) { var v = Math.abs(data[j]); if (v > p) p = v; }
      vals.push(p); if (p > peak) peak = p;
    }
    ctx2.fillStyle = "#4bef05";
    vals.forEach(function (p, k) { var hh = Math.max(1, (p / (peak || 1)) * (h / 2 - 1)); ctx2.fillRect(k * 3, h / 2 - hh, 2, hh * 2); });
  }
  function positionPopover() {
    var m = find(selectedId);
    if (popover.hidden || !m) return;
    // The popover lives outside the scrolling lane so it can hang below it.
    var x = timeToX(beats[m.i]) - scroller.scrollLeft, pw = popover.offsetWidth || 380;
    var base = frame.offsetLeft;
    popover.style.left = (base + clamp(x + 8, 8, Math.max(8, viewW - pw - 8))) + "px";
  }

  // Voice recording.
  var rec = null, recTimer = null;
  function encodeWav(samples, sr) {
    var buf = new ArrayBuffer(44 + samples.length * 2), v = new DataView(buf);
    function str(o, s) { for (var k = 0; k < s.length; k++) v.setUint8(o + k, s.charCodeAt(k)); }
    str(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); str(8, "WAVE"); str(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, sr, true);
    v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, "data");
    v.setUint32(40, samples.length * 2, true);
    for (var k = 0; k < samples.length; k++) v.setInt16(44 + k * 2, Math.max(-1, Math.min(1, samples[k])) * 0x7fff, true);
    return new Blob([buf], { type: "audio/wav" });
  }
  function trimVoice(buf) {
    var n = buf.length, mono = new Float32Array(n), ch = buf.numberOfChannels;
    for (var c = 0; c < ch; c++) { var d = buf.getChannelData(c); for (var k = 0; k < n; k++) mono[k] += d[k] / ch; }
    var peak = 0;
    for (var k2 = 0; k2 < n; k2++) if (Math.abs(mono[k2]) > peak) peak = Math.abs(mono[k2]);
    var thr = Math.max(0.015, peak * 0.08), a = 0, b = n - 1;
    while (a < n && Math.abs(mono[a]) < thr) a++;
    while (b > a && Math.abs(mono[b]) < thr) b--;
    var pad = Math.round(0.05 * buf.sampleRate);
    a = Math.max(0, a - pad); b = Math.min(n, b + pad);
    b = Math.min(b, a + Math.round(VOICE_MAX * buf.sampleRate));
    var out = mono.slice(a, b);
    for (var f = 0; f < Math.min(240, out.length); f++) { out[f] *= f / 240; out[out.length - 1 - f] *= f / 240; }
    return { samples: out, peak: peak };
  }
  function toggleRecord() {
    var m = find(selectedId);
    if (!m) return;
    if (rec) { rec.stop(); return; }
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      showError("This browser can't record audio. Try Chrome, Edge, Firefox or Safari.");
      return;
    }
    ensureCtx();
    var markerId = m.id;
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }).then(function (stream) {
      var chunks = [], mr = new MediaRecorder(stream), started = performance.now();
      rec = mr;
      mr.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
      mr.onstop = function () {
        stream.getTracks().forEach(function (t) { t.stop(); });
        clearInterval(recTimer);
        rec = null;
        $("voice-record").classList.remove("on");
        var blob = new Blob(chunks, { type: mr.mimeType || "audio/webm" });
        blob.arrayBuffer().then(function (ab) { return ctx.decodeAudioData(ab); }).then(function (buf) {
          var t = trimVoice(buf);
          if (t.peak < 0.01 || t.samples.length < buf.sampleRate * 0.15) throw new Error("Didn't catch that. Check your mic and try again.");
          var clean = ctx.createBuffer(1, t.samples.length, buf.sampleRate);
          clean.copyToChannel(t.samples, 0);
          var data = new FormData();
          data.append("file", encodeWav(t.samples, buf.sampleRate), "cue.wav");
          return fetch("/job/" + job.job_id + "/voice", { method: "POST", body: data })
            .then(function (res) { return res.json().then(function (b) { if (!res.ok) throw new Error(b.detail || "Could not save the voice cue."); return b; }); })
            .then(function (b) {
              voiceBuffers[b.id] = clean;
              var target = find(markerId);
              if (target) { pushUndo(); target.voice = b.id; changed(); }
              if (selectedId === markerId) renderPopover();
            });
        }).catch(function (err) {
          showError(err.message || "Could not record the voice cue.");
          if (selectedId === markerId) renderPopover();
        });
      };
      mr.start();
      $("voice-record").classList.add("on");
      recTimer = setInterval(function () {
        var s = (performance.now() - started) / 1000;
        $("voice-record-label").textContent = "Stop · " + s.toFixed(1) + " s";
        if (s >= VOICE_MAX) mr.stop();
      }, 100);
      renderPopover();
    }).catch(function () {
      showError("Microphone access was blocked. Allow it in the browser to record cues.");
    });
  }
  function loadVoice(id) {
    if (!id || voiceBuffers[id] || voiceLoading[id] || !job) return;
    voiceLoading[id] = true;
    ensureCtx(true);
    fetch("/job/" + job.job_id + "/voice/" + id).then(function (r) {
      if (!r.ok) throw new Error("missing");
      return r.arrayBuffer();
    }).then(function (ab) { return ctx.decodeAudioData(ab); }).then(function (buf) {
      voiceBuffers[id] = buf;
      if (!popover.hidden) renderPopover();
    }).catch(function () { /* missing note: render falls back to the cue tone */ });
  }
  function playVoiceNow(id) {
    ensureCtx();
    var buf = voiceBuffers[id];
    if (!buf) return;
    var src = ctx.createBufferSource();
    src.buffer = buf; src.connect(voiceGain); src.start();
  }

  $("voice-record").addEventListener("click", toggleRecord);
  $("voice-play").addEventListener("click", function () { var m = find(selectedId); if (m && m.voice) playVoiceNow(m.voice); });
  $("voice-remove").addEventListener("click", function () {
    var m = find(selectedId);
    if (!m || !m.voice) return;
    pushUndo(); m.voice = null; changed(); renderPopover();
  });

  /* =========================================================== pointer: drag, click, seek, add */
  var drag = null;
  function eventTime(clientX) {
    var rect = scroller.getBoundingClientRect();
    return xToTime(clientX - rect.left + scroller.scrollLeft);
  }
  function snapIndex(time, toBar) {
    if (toBar && barLines.length) {
      var near = barLines.map(function (i) { return beats[i]; });
      return barLines[S.nearestBeatIndex(near, time)];
    }
    return S.nearestBeatIndex(beats, time);
  }
  markersEl.addEventListener("pointerdown", function (e) {
    var el = e.target.closest(".marker");
    if (!el || e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    drag = { id: Number(el.dataset.id), startX: e.clientX, clientX: e.clientX, shift: e.shiftKey, moved: false, before: snapshot(), pointerId: e.pointerId };
    el.setPointerCapture(e.pointerId);
    el.focus({ preventScroll: true });
  });
  markersEl.addEventListener("pointermove", function (e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    drag.clientX = e.clientX; drag.shift = e.shiftKey;
    if (!drag.moved) {
      if (Math.abs(e.clientX - drag.startX) < 6) return;
      drag.moved = true; closePopover(); selectedId = drag.id;
    }
    dragTo();
    if (!drag.raf) drag.raf = requestAnimationFrame(edgeScroll);
  });
  function dragTo() {
    if (moveMarker(drag.id, snapIndex(eventTime(drag.clientX), drag.shift))) changed({ transient: true });
    else renderMarkers();
  }
  function edgeScroll() {
    if (!drag || !drag.moved) return;
    var rect = scroller.getBoundingClientRect(), before = scroller.scrollLeft;
    if (drag.clientX > rect.right - 36) scroller.scrollLeft += 12;
    else if (drag.clientX < rect.left + 36) scroller.scrollLeft -= 12;
    if (scroller.scrollLeft !== before) dragTo();
    drag.raf = requestAnimationFrame(edgeScroll);
  }
  function endDrag(e) {
    if (!drag || (e && e.pointerId !== drag.pointerId)) return;
    var d = drag; drag = null;
    if (d.moved) {
      if (snapshot() !== d.before) { undoStack.push(d.before); redoStack.length = 0; }
      changed();
    } else if (selectedId === d.id && !popover.hidden) { closePopover(); renderMarkers(); }
    else openPopover(d.id);
  }
  markersEl.addEventListener("pointerup", endDrag);
  markersEl.addEventListener("pointercancel", endDrag);
  markersEl.addEventListener("dblclick", function (e) { e.stopPropagation(); });
  ["pointerdown", "dblclick", "click"].forEach(function (t) { popover.addEventListener(t, function (e) { e.stopPropagation(); }); });

  $("meters").addEventListener("click", function (e) { var b = e.target.closest("button"); if (b) setMeter(selectedId, b.dataset.meter); });
  var labelBefore = null;
  $("label").addEventListener("focus", function () { labelBefore = snapshot(); });
  $("label").addEventListener("input", function () {
    var m = find(selectedId);
    if (!m) return;
    m.label = $("label").value.slice(0, 40);
    buildSections(); renderMarkers(); renderMap();
  });
  $("label").addEventListener("change", function () {
    if (labelBefore && labelBefore !== snapshot()) { undoStack.push(labelBefore); redoStack.length = 0; changed(); }
    labelBefore = snapshot();
  });
  $("label").addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === "Escape") { e.preventDefault(); $("label").blur(); closePopover(); renderMarkers(); }
    e.stopPropagation();
  });
  $("delete-marker").addEventListener("click", function () { removeMarker(selectedId); });

  var bgDown = null;
  scroller.addEventListener("pointerdown", function (e) {
    if (e.button !== 0 || e.target.closest(".marker") || e.target.closest(".popover")) return;
    bgDown = { x: e.clientX, y: e.clientY };
  });
  scroller.addEventListener("pointerup", function (e) {
    if (!bgDown) return;
    var still = Math.abs(e.clientX - bgDown.x) < 4 && Math.abs(e.clientY - bgDown.y) < 4;
    bgDown = null;
    if (!still) return;
    if (!popover.hidden) { closePopover(); selectedId = null; renderMarkers(); renderAccents(); return; }
    if (selectedId !== null) { selectedId = null; renderMarkers(); renderAccents(); }
    seek(eventTime(e.clientX));
  });
  scroller.addEventListener("dblclick", function (e) {
    if (e.target.closest(".marker") || e.target.closest(".popover")) return;
    addMarkerAt(eventTime(e.clientX));
  });
  scroller.addEventListener("scroll", function () { requestDraw(); positionPopover(); });
  scroller.addEventListener("wheel", function (e) {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      setZoom(zoom * Math.exp(-e.deltaY * 0.01), e.clientX - scroller.getBoundingClientRect().left);
    } else if (zoom > 1 && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      e.preventDefault(); scroller.scrollLeft += e.deltaY;
    }
  }, { passive: false });
  function setZoom(z, anchorX) {
    z = clamp(z, 1, 40);
    if (anchorX === undefined) anchorX = viewW / 2;
    var t = xToTime(scroller.scrollLeft + anchorX);
    zoom = z; $("zoom").value = z;
    layout();
    scroller.scrollLeft = timeToX(t) - anchorX;
    requestDraw();
  }
  $("zoom").addEventListener("input", function () {
    var x = timeToX(songTime()) - scroller.scrollLeft;
    setZoom(parseFloat($("zoom").value), x >= 0 && x <= viewW ? x : undefined);
  });

  /* =========================================================== song map */
  var mapEl = $("songmap"), mapHead = null;
  function renderMap() {
    if (!job) return;
    var html = "";
    var oneT = secInfo.length ? secInfo[0].startT : 0;
    if (oneT > 0.5) html += '<button type="button" class="sec pickup" data-k="-1" style="flex:' + oneT.toFixed(3) + ' 1 0" title="Before the 1" aria-label="Before the 1"></button>';
    var cur = sectionAtIndex(beatAtOrBefore(songTime()));
    secInfo.forEach(function (s, k) {
      var cls = "sec" + (isChorus(s.label) ? " chorus" : (k % 2 ? " alt" : "")) + (s.low ? " low" : "") +
        (k === cur ? " current" : "") + (loopOn && loopSec && loopSec.index === s.index ? " looping" : "");
      html += '<button type="button" class="' + cls + '" data-k="' + k + '" style="flex:' + Math.max(0.01, s.endT - s.startT).toFixed(3) + ' 1 0">' +
        '<span class="n"></span><span class="m"></span></button>';
    });
    mapEl.innerHTML = html + '<span class="map-head" id="map-head"></span>';
    mapHead = $("map-head");
    Array.prototype.forEach.call(mapEl.querySelectorAll(".sec[data-k]"), function (b) {
      var k = Number(b.dataset.k);
      if (k < 0) return;
      b.querySelector(".n").textContent = secInfo[k].label;
      b.querySelector(".m").textContent = secInfo[k].meter + (secInfo[k].low ? " ?" : "");
      b.title = secInfo[k].label + " · " + secInfo[k].meter + " · " + fmtTime(secInfo[k].startT);
    });
    $("map-range").textContent = "0:00 – " + fmtTime(duration);
    mapCurrent = cur;
  }
  var mapCurrent = -1;
  mapEl.addEventListener("click", function (e) {
    var b = e.target.closest(".sec");
    if (!b) return;
    var k = Number(b.dataset.k);
    var t = k < 0 ? 0 : secInfo[k].startT;
    if (loopOn && k >= 0) { loopSec = secInfo[k]; }
    seek(Math.max(0, t - 0.02));
    renderMap();
  });

  /* =========================================================== audio + live click preview */
  var ctx = null, master = null, voiceGain = null, pending = [], nextEvent = 0, anchor = null;
  function ensureCtx(silent) {
    if (!ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      ctx = new AC({ latencyHint: "interactive" });
      master = ctx.createGain(); master.gain.value = 0.6; master.connect(ctx.destination);
      voiceGain = ctx.createGain(); voiceGain.gain.value = 1.0; voiceGain.connect(ctx.destination);
    }
    if (!silent && ctx.state === "suspended") ctx.resume();
  }
  function songTime() {
    if (!audio.paused && ctx && anchor) return Math.min(duration, anchor.song + (ctx.currentTime - anchor.ctx) * anchor.rate);
    return audio.currentTime || 0;
  }
  function cancelPending() {
    var now = ctx ? ctx.currentTime : 0;
    pending.forEach(function (p) { if (p.when > now - 0.01) { try { p.node.stop(); p.node.disconnect(); } catch (e) { /* done */ } } });
    pending = [];
  }
  function resync() { cancelPending(); anchor = null; }
  function firstEventAt(t) {
    var lo = 0, hi = schedule.length;
    while (lo < hi) { var mid = (lo + hi) >> 1; if (schedule[mid].time < t) lo = mid + 1; else hi = mid; }
    return lo;
  }
  function playEvent(ev, when) {
    var node;
    if (ev.kind === "voice" && voiceBuffers[ev.note]) {
      node = ctx.createBufferSource();
      node.buffer = voiceBuffers[ev.note];
      node.connect(voiceGain);
      node.start(when);
    } else {
      var s = S.SOUNDS[ev.kind === "voice" ? "precue" : ev.kind], osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = "sine"; osc.frequency.value = s[0];
      gain.gain.setValueAtTime(s[2], when);
      gain.gain.exponentialRampToValueAtTime(s[2] * Math.exp(-S.DECAY * s[1]), when + s[1]);
      osc.connect(gain); gain.connect(master);
      osc.start(when); osc.stop(when + s[1]);
      node = osc;
    }
    pending.push({ node: node, when: when });
    if (pending.length > 96) pending.splice(0, 48);
  }
  function tick() {
    if (!ctx || !job || audio.paused || audio.seeking) return;
    var measured = audio.currentTime, rate = audio.playbackRate || 1;
    if (!anchor || anchor.rate !== rate || Math.abs(measured - songTime()) > 0.08) {
      cancelPending();
      anchor = { ctx: ctx.currentTime, song: measured, rate: rate };
      nextEvent = firstEventAt(measured - 0.005);
    } else {
      anchor.song += 0.05 * (measured - songTime());
    }
    var now = songTime();
    if (loopOn && loopSec && now >= loopSec.endT - 0.015) { seek(loopSec.startT); return; }
    if (listen === "song") { nextEvent = firstEventAt(now); return; }
    var horizon = ctx.currentTime + 0.15;
    while (nextEvent < schedule.length) {
      var ev = schedule[nextEvent], when = anchor.ctx + (ev.time - anchor.song) / anchor.rate;
      if (when > horizon) break;
      if (when > ctx.currentTime - 0.03) playEvent(ev, Math.max(when, ctx.currentTime));
      nextEvent++;
    }
  }
  setInterval(tick, 25);

  function seek(t) {
    audio.currentTime = clamp(t, 0, Math.max(0, duration - 0.01));
    resync(); updatePlayhead(true);
  }
  function togglePlay() {
    if (!job) return;
    ensureCtx();
    if (audio.paused) {
      resync();
      if (audio.currentTime >= duration - 0.05) audio.currentTime = 0;
      audio.play().catch(function () { showError("The browser blocked playback. Press play again."); });
    } else audio.pause();
  }
  function setPlayIcon(playing) {
    var d = playing ? "M6 4.5h4.5v15H6zM13.5 4.5H18v15h-4.5z" : "M7 4.5v15l13-7.5z";
    $("play-icon").setAttribute("d", d); $("pv-play-icon").setAttribute("d", d);
    $("play").setAttribute("aria-label", playing ? "Pause" : "Play");
    $("pv-play").setAttribute("aria-label", playing ? "Pause" : "Play");
  }
  audio.addEventListener("play", function () { setPlayIcon(true); resync(); });
  audio.addEventListener("pause", function () { setPlayIcon(false); resync(); requestDraw(); });
  audio.addEventListener("seeked", resync);
  audio.addEventListener("ended", function () { setPlayIcon(false); resync(); });
  function setListen(next) {
    listen = next;
    audio.muted = listen === "click";
    audio.volume = listen === "both" ? 0.75 : 1;
    document.querySelectorAll("[data-listen]").forEach(function (b) { b.setAttribute("aria-checked", String(b.dataset.listen === listen)); });
    if (listen === "song") cancelPending(); else anchor = null;
  }
  function setLoop(on) {
    loopOn = on;
    loopSec = on ? secInfo[sectionAtIndex(beatAtOrBefore(songTime()))] : null;
    $("loop").setAttribute("aria-pressed", String(on));
    $("pv-loop").setAttribute("aria-pressed", String(on));
    $("loop-label").textContent = on && loopSec ? "Looping " + loopSec.label : "Loop section";
    renderMap();
  }

  /* =========================================================== playhead, readouts, practice */
  var lastBeat = -1, ledOff = 0;
  function updatePlayhead(force) {
    if (!job) return;
    var t = songTime(), x = timeToX(t);
    playheadEl.style.transform = "translateX(" + x + "px)";
    if (mapHead) mapHead.style.left = (100 * t / Math.max(duration, 0.001)) + "%";
    if (!audio.paused && zoom > 1 && !drag && !bgDown && popover.hidden && view === "edit") {
      var rel = x - scroller.scrollLeft;
      if (rel < 0 || rel > viewW) scroller.scrollLeft = x - viewW * 0.3;
      else if (rel > viewW * 0.6) scroller.scrollLeft += Math.min(rel - viewW * 0.6, 30);
    } else if (force && zoom > 1) {
      var r = x - scroller.scrollLeft;
      if (r > viewW || r < 0) scroller.scrollLeft = x - viewW * 0.3;
    }
    $("time").textContent = fmtTime(t, true);
    if (!beats.length || !secInfo.length) return;
    var i = beatAtOrBefore(t), one = secInfo[0];
    var text, big, dots = [], next = null, k = 0;
    if (t < one.startT - 0.02) {
      var counts = schedule.filter(function (e) { return e.kind === "count"; });
      var inCount = counts.length && t >= counts[0].time - 0.02;
      text = inCount ? "Count-in" : "Before the 1";
      big = inCount ? String(counts.filter(function (e) { return e.time <= t + 0.02; }).length || "–") : "–";
      for (var c = 0; c < one.bpb; c++) dots.push(c === 0 ? "" : "");
      next = { label: one.label, bars: null, voice: !!one.marker.voice, meter: null };
      $("pv-section").textContent = inCount ? "Count-in" : "Pickup";
      $("pv-meter").textContent = one.meter;
      i = -1;
    } else {
      k = sectionAtIndex(i);
      var sec = secInfo[k], off = i - sec.index, n = sec.bpb, pos = off % n, bar = Math.floor(off / n) + 1;
      text = sec.label + " · bar " + bar + " · beat " + (pos + 1);
      big = '<span>' + bar + '</span><span class="sep">·</span><span class="beat">' + (pos + 1) + "</span>";
      var levels = S.accentsFor(settings, n);
      for (var d = 0; d < n; d++) dots.push(d === pos ? "on" : levels[d] === 3 ? "off" : "");
      if (k + 1 < secInfo.length) {
        var nx = secInfo[k + 1], bars = Math.ceil((nx.index - i) / n);
        next = { label: nx.label, bars: bars, voice: !!nx.marker.voice, meter: nx.meter !== sec.meter ? nx.meter : null };
      }
      $("pv-section").textContent = sec.label;
      $("pv-meter").textContent = sec.meter;
      if (k !== mapCurrent) renderMap();
    }
    $("position").textContent = text;
    var pvBig = $("pv-big");
    if (pvBig.dataset.v !== big) { pvBig.dataset.v = big; pvBig.innerHTML = big; }
    var dotsKey = dots.join(",");
    if ($("pv-dots").dataset.v !== dotsKey) {
      $("pv-dots").dataset.v = dotsKey;
      $("pv-dots").innerHTML = dots.map(function (cl) { return '<i class="' + cl + '"></i>'; }).join("");
    }
    var nextEl = $("pv-next");
    if (next) {
      nextEl.classList.remove("empty");
      $("pv-next-title").textContent = next.label + (next.bars === null ? " is next" : next.bars <= 1 ? " next bar" : " in " + next.bars + " bars");
      $("pv-next-sub").textContent = next.voice ? "Your voice cue plays one bar before" : next.meter ? "Changes to " + next.meter : "";
    } else nextEl.classList.add("empty");
    if (i !== lastBeat && !audio.paused && i >= 0) {
      var s2 = secInfo[sectionAtIndex(i)];
      $("led").className = "led on" + ((i - s2.index) % s2.bpb === 0 ? " down" : "");
      ledOff = performance.now() + 90;
    }
    lastBeat = i;
    if (ledOff && performance.now() > ledOff) { $("led").className = "led"; ledOff = 0; }
  }
  (function loop() {
    updatePlayhead(false);
    if (!audio.paused) requestDraw();
    requestAnimationFrame(loop);
  })();

  function setView(next) {
    view = next;
    $("edit-view").hidden = view !== "edit";
    $("practice-view").hidden = view !== "practice";
    body.classList.toggle("practicing", view === "practice");
    document.querySelectorAll("[data-view]").forEach(function (b) { b.setAttribute("aria-checked", String(b.dataset.view === view)); });
    if (view === "edit") { closePopover(); requestAnimationFrame(layout); }
  }
  document.querySelectorAll("[data-view]").forEach(function (b) { b.addEventListener("click", function () { setView(b.dataset.view); }); });
  $("pv-back").addEventListener("click", function () { setView("edit"); });
  $("pv-play").addEventListener("click", togglePlay);
  $("pv-loop").addEventListener("click", function () { setLoop(!loopOn); });
  $("pv-prev").addEventListener("click", function () {
    var t = songTime(), k = sectionAtIndex(beatAtOrBefore(t));
    if (t < secInfo[0].startT) return seek(0);
    var target = t - secInfo[k].startT < 1.5 && k > 0 ? secInfo[k - 1].startT : secInfo[k].startT;
    seek(target);
  });

  /* =========================================================== settings: count-in, accents */
  function renderCountIn() {
    document.querySelectorAll("#countin [data-bars]").forEach(function (b) {
      b.setAttribute("aria-checked", String(Number(b.dataset.bars) === settings.count_in_bars));
    });
  }
  $("countin").addEventListener("click", function (e) {
    var b = e.target.closest("[data-bars]");
    if (!b || Number(b.dataset.bars) === settings.count_in_bars) return;
    pushUndo(); settings.count_in_bars = Number(b.dataset.bars); changed();
  });

  function accentTarget() {
    var m = find(selectedId);
    if (m) return { n: S.beatsPerBar(m.meter), meter: m.meter };
    if (!secInfo.length) return { n: 4, meter: "4/4" };
    var s = secInfo[sectionAtIndex(beatAtOrBefore(songTime()))];
    return { n: s.bpb, meter: s.meter };
  }
  function presetsFor(n) {
    var list = [["Accent the 1", [0].concat(Array(n - 1).fill(1))], ["All equal", Array(n).fill(1)]];
    if (n === 4) list.splice(1, 0, ["Backbeat 2 & 4", [1, 0, 1, 0]], ["Only 2 & 4", [3, 0, 3, 0]]);
    if (n === 6 || n === 9 || n === 12) list.unshift(["Felt in dotted quarters", S.defaultAccents(n)]);
    if (n === 2) list.splice(1, 0, ["Only beat 2", [3, 0]]);
    return list;
  }
  var accentKey = "";
  function renderAccents() {
    if (!job) return;
    var tgt = accentTarget(), levels = S.accentsFor(settings, tgt.n);
    var key = tgt.n + ":" + levels.join("") + ":" + tgt.meter;
    if (key === accentKey) return;
    accentKey = key;
    $("accent-meter").textContent = "· " + tgt.meter;
    $("accent-meter-2").textContent = tgt.meter;
    $("accents").innerHTML = levels.map(function (lvl, i) {
      return '<span class="accent"><button type="button" class="l' + lvl + '" data-beat="' + i + '" aria-label="Beat ' + (i + 1) + ": " + S.LEVELS[lvl] + '. Tap to change.">' + (i + 1) + "</button><span>" + S.LEVELS[lvl] + "</span></span>";
    }).join("");
    $("presets").innerHTML = presetsFor(tgt.n).map(function (p, k) {
      return '<button type="button" data-preset="' + k + '">' + p[0] + "</button>";
    }).join("");
  }
  $("accents").addEventListener("click", function (e) {
    var b = e.target.closest("[data-beat]");
    if (!b) return;
    var tgt = accentTarget(), levels = S.accentsFor(settings, tgt.n), i = Number(b.dataset.beat);
    pushUndo();
    levels[i] = (levels[i] + 1) % 4;
    settings.accents = Object.assign({}, settings.accents);
    settings.accents[String(tgt.n)] = levels;
    changed();
  });
  $("presets").addEventListener("click", function (e) {
    var b = e.target.closest("[data-preset]");
    if (!b) return;
    var tgt = accentTarget(), p = presetsFor(tgt.n)[Number(b.dataset.preset)];
    pushUndo();
    settings.accents = Object.assign({}, settings.accents);
    settings.accents[String(tgt.n)] = p[1].slice();
    changed();
  });

  $("grid").addEventListener("change", function () { setGrid($("grid").value); });

  function renderSongInfo() {
    if (!job) return;
    var factor = settings.grid === "half" ? 0.5 : settings.grid === "double" ? 2 : 1;
    $("bpm").textContent = Math.round(job.bpm * factor * 10) / 10 + " BPM";
    $("song-meta").textContent = fmtTime(duration) + " · " + secInfo.length + (secInfo.length === 1 ? " section" : " sections");
    var unsure = markers.filter(function (m) { return m.auto && m.conf !== null && m.conf < 0.5; }).length;
    $("check-count").hidden = !unsure;
    $("check-count").querySelector("span").textContent = unsure + (unsure === 1 ? " time signature to check" : " time signatures to check");
    $("grid").value = settings.grid;
  }

  /* =========================================================== keyboard */
  document.addEventListener("keydown", function (e) {
    if (!job || !body.classList.contains("has-job")) return;
    var tag = (e.target.tagName || "").toLowerCase();
    if ((tag === "input" && e.target.type !== "range") || tag === "select" || tag === "textarea") return;
    var mod = e.ctrlKey || e.metaKey, key = e.key;
    if (mod && key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (mod && key.toLowerCase() === "y") { e.preventDefault(); redo(); return; }
    if (mod || e.altKey) return;
    if (key === " " || key === "Spacebar") { e.preventDefault(); togglePlay(); }
    else if (key === "m" || key === "M") { e.preventDefault(); addMarkerAt(songTime()); }
    else if (key === "l" || key === "L") { e.preventDefault(); setLoop(!loopOn); }
    else if (key === "p" || key === "P") { e.preventDefault(); setView(view === "edit" ? "practice" : "edit"); }
    else if (key === "Delete" || key === "Backspace") { if (selectedId !== null) { e.preventDefault(); removeMarker(selectedId); } }
    else if (key === "Escape") { if (view === "practice") setView("edit"); closePopover(); selectedId = null; renderMarkers(); renderAccents(); }
    else if (key === "Enter" && e.target.classList && e.target.classList.contains("marker")) { e.preventDefault(); openPopover(Number(e.target.dataset.id)); }
    else if (key === "ArrowLeft" || key === "ArrowRight") {
      var dir = key === "ArrowLeft" ? -1 : 1, m = find(selectedId);
      e.preventDefault();
      if (m) {
        var before = snapshot(), target = m.i + dir * (e.shiftKey ? S.beatsPerBar(meterAt(Math.max(0, m.i - 1))) : 1);
        var guard = 0;
        while (occupied(target, m.id) && guard++ < 8) target += dir;
        if (moveMarker(m.id, target)) { undoStack.push(before); redoStack.length = 0; changed(); positionPopover(); }
      } else seek(songTime() + dir * 5);
    }
  });
  $("play").addEventListener("click", togglePlay);
  $("add-marker").addEventListener("click", function () { addMarkerAt(songTime()); });
  $("undo").addEventListener("click", undo);
  $("redo").addEventListener("click", redo);
  $("loop").addEventListener("click", function () { setLoop(!loopOn); });
  $("speed").addEventListener("change", function () { audio.playbackRate = Number($("speed").value); resync(); });
  document.querySelectorAll("[data-listen]").forEach(function (b) { b.addEventListener("click", function () { setListen(b.dataset.listen); }); });
  $("reset").addEventListener("click", function () {
    pushUndo();
    settings = { count_in_bars: 1, grid: "normal", accents: {} };
    beats = rawBeats.slice();
    markers = fromAnalysis(detected);
    selectedId = null; closePopover(); changed();
  });

  /* =========================================================== render + download */
  function markStale() {
    var box = $("dl-links");
    if (!box.hidden) {
      box.closest(".download").classList.add("stale");
      $("render-status").textContent = "You changed the map since this render. Press Download again.";
    }
  }
  $("download").addEventListener("click", function () {
    var btn = $("download");
    btn.disabled = true; btn.textContent = "Rendering…"; showError("");
    fetch("/render/" + job.job_id, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markers: exportMarkers(), settings: settings }),
    }).then(function (res) {
      return res.json().then(function (b) { if (!res.ok) throw new Error(b.detail || "Rendering failed."); return b; });
    }).then(function (b) {
      var bust = "?t=" + Date.now();
      $("dl-click").href = b.click + bust; $("dl-mix").href = b.mix + bust;
      $("dl-links").hidden = false;
      $("dl-links").closest(".download").classList.remove("stale");
      $("render-status").textContent = "Ready. These match the preview you just heard (at 100% speed).";
    }).catch(function (err) { showError(err.message); })
      .then(function () { btn.disabled = false; btn.textContent = "Download click track"; });
  });

  /* =========================================================== load a job */
  function fromAnalysis(list) {
    var out = [], id = 1, used = {};
    list.forEach(function (m) {
      var i = S.nearestBeatIndex(beats, m.time);
      if (used[i]) return;
      used[i] = true;
      out.push({ id: id++, i: i, meter: m.meter, label: m.label || "", voice: null,
        conf: typeof m.meter_confidence === "number" ? m.meter_confidence : null, auto: true });
    });
    nextId = id;
    return out;
  }
  function computePeaks(buf) {
    var rate = peaksRate, n = Math.ceil(buf.duration * rate), per = Math.max(1, Math.floor(buf.sampleRate / rate));
    var ch = buf.numberOfChannels, out = new Float32Array(n), maxAll = 0;
    var chans = []; for (var c = 0; c < ch; c++) chans.push(buf.getChannelData(c));
    for (var k = 0; k < n; k++) {
      var p = 0, end = Math.min(buf.length, (k + 1) * per);
      for (var j = k * per; j < end; j += 4) {
        for (var c2 = 0; c2 < ch; c2++) { var v = Math.abs(chans[c2][j]); if (v > p) p = v; }
      }
      out[k] = p; if (p > maxAll) maxAll = p;
    }
    if (maxAll > 0) for (var q = 0; q < n; q++) out[q] = Math.sqrt(out[q] / maxAll);  // perceptual-ish
    return out;
  }
  function loadJob(id) {
    showError("");
    return fetch("/job/" + id + "/analysis").then(function (res) {
      if (!res.ok) throw new Error("This song has expired (they're kept for 2 hours). Upload it again.");
      return res.json();
    }).then(function (a) {
      job = a;
      rawBeats = a.beats; duration = a.duration; detected = a.markers;
      storeKey = "drummerchart:v3:" + id;
      settings = { count_in_bars: 1, grid: "normal", accents: {} };
      beats = rawBeats.slice();
      markers = fromAnalysis(detected);
      undoStack = []; redoStack = []; selectedId = null; loopOn = false; loopSec = null;
      try {
        var saved = JSON.parse(localStorage.getItem(storeKey) || "null");
        if (saved && Array.isArray(saved.markers) && saved.markers.length && saved.settings) {
          var b2 = S.applyGrid(rawBeats, saved.settings.grid);
          if (saved.markers.every(function (m) { return m.i >= 0 && m.i < b2.length; })) {
            settings = saved.settings; beats = b2; markers = saved.markers;
            nextId = markers.reduce(function (n, m) { return Math.max(n, m.id + 1); }, 1);
          }
        }
      } catch (e) { /* ignore */ }
      markers.forEach(function (m) { if (m.voice) loadVoice(m.voice); });

      body.classList.add("has-job");
      document.title = (a.filename || "Song") + " — Drummer Chart AI";
      $("song-title").textContent = a.filename || "song.mp3";
      $("song-title").title = a.filename || "";
      $("pv-song").textContent = a.filename || "";
      $("total").textContent = fmtTime(duration);
      $("dl-links").hidden = true;
      $("render-status").textContent = "Exactly what you hear in the preview at 100% speed: clicks, count-in, cues and your voice notes.";
      Object.keys(markerEls).forEach(function (k) { markerEls[k].remove(); delete markerEls[k]; });
      accentKey = "";
      peaks = null;
      audio.src = "/job/" + id + "/audio";
      audio.playbackRate = Number($("speed").value);
      setListen(listen); setView("edit"); $("loop").setAttribute("aria-pressed", "false"); $("loop-label").textContent = "Loop section";
      zoom = clamp(duration / 30, 1, 40); $("zoom").value = zoom;
      window.scrollTo(0, 0);
      changed({ transient: true });
      requestAnimationFrame(function () { layout(); scroller.scrollLeft = 0; });

      ensureCtx(true);
      fetch("/job/" + id + "/audio").then(function (r) { return r.arrayBuffer(); })
        .then(function (ab) { return ctx.decodeAudioData(ab); })
        .then(function (buf) { if (job && job.job_id === id) { peaks = computePeaks(buf); requestDraw(); } })
        .catch(function () { /* waveform is optional */ });
    }).catch(function (err) {
      goHome(false);
      $("drop-error").textContent = err.message;
      $("drop-error").hidden = false;
      history.replaceState({}, "", "/");
    });
  }

  if (window.ResizeObserver) new ResizeObserver(function () { layout(); }).observe(frame);
  else window.addEventListener("resize", layout);

  var initial = body.dataset.jobId;
  if (initial) loadJob(initial);

  // Small hook for automated tests and debugging.
  window.DCApp = {
    markers: function () { return exportMarkers(); },
    settings: function () { return JSON.parse(JSON.stringify(settings)); },
    schedule: function () { return schedule; },
    songTime: songTime,
    hasWaveform: function () { return !!peaks; },
  };
})();
