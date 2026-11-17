/* Marker editor: timeline, draggable markers, and the live click preview.
   Vanilla JS, no build step. The click schedule comes from schedule.js (DCSchedule),
   the same rules the server uses to render the final WAVs. */
(function () {
  "use strict";

  var S = window.DCSchedule;
  var jobId = document.body.dataset.jobId;
  var $ = function (id) { return document.getElementById(id); };

  var audio = $("audio");
  var frame = $("frame"), canvas = $("grid"), scroller = $("scroller"), inner = $("inner");
  var playheadEl = $("playhead"), markersEl = $("markers"), popover = $("popover");
  var g = canvas.getContext("2d");

  var PAD = 18;          // px of air left and right of the song
  var RULER = 24;        // px, time ruler height
  var STORE_KEY = "drummerchart:markers:" + jobId;

  var beats = [], downbeats = [], duration = 0, detected = [];
  var markers = [];      // {id, i (beat index), meter, label, conf, auto}
  var selectedId = null, nextId = 1;
  var undoStack = [], redoStack = [];
  var zoom = 1, viewW = 0, viewH = 0, pxPerSec = 1;
  var mode = "both";
  var schedule = [], sections = [];
  var drawQueued = false;

  /* ---------- helpers ---------- */
  function fmtTime(t, tenths) {
    t = Math.max(0, t);
    var m = Math.floor(t / 60), s = t - m * 60;
    var whole = tenths ? s.toFixed(1) : String(Math.floor(s));
    if (parseFloat(whole) < 10) whole = "0" + whole;
    return m + ":" + whole;
  }
  function timeToX(t) { return PAD + t * pxPerSec; }
  function xToTime(x) { return (x - PAD) / pxPerSec; }
  function lowerBound(arr, t) {            // first index with arr[i] >= t
    var lo = 0, hi = arr.length;
    while (lo < hi) { var mid = (lo + hi) >> 1; if (arr[mid] < t) lo = mid + 1; else hi = mid; }
    return lo;
  }
  function beatAtOrBefore(t) { return Math.max(0, lowerBound(beats, t + 1e-6) - 1); }
  function byIndex(a, b) { return a.i - b.i; }
  function sorted() { return markers.slice().sort(byIndex); }
  function find(id) { for (var k = 0; k < markers.length; k++) if (markers[k].id === id) return markers[k]; return null; }
  function occupied(i, exceptId) { return markers.some(function (m) { return m.i === i && m.id !== exceptId; }); }
  function exportMarkers() {
    return sorted().map(function (m) { return { time: beats[m.i], meter: m.meter, label: m.label }; });
  }

  /* ---------- state changes ---------- */
  function snapshot() { return JSON.stringify({ markers: markers, selectedId: selectedId }); }
  function restore(snap) {
    var s = JSON.parse(snap);
    markers = s.markers; selectedId = find(s.selectedId) ? s.selectedId : null;
    nextId = markers.reduce(function (n, m) { return Math.max(n, m.id + 1); }, 1);
  }
  function pushUndo(snap) {
    undoStack.push(snap || snapshot());
    if (undoStack.length > 200) undoStack.shift();
    redoStack.length = 0;
  }
  function changed(opts) {
    sections = S.resolveMarkers(beats, exportMarkers());
    schedule = S.buildClickSchedule(beats, exportMarkers(), duration);
    resync();
    if (!opts || !opts.transient) {
      try { localStorage.setItem(STORE_KEY, JSON.stringify(markers)); } catch (e) { /* private mode */ }
      markStale();
    }
    $("undo").disabled = !undoStack.length;
    $("redo").disabled = !redoStack.length;
    renderMarkers();
    requestDraw();
  }
  function undo() {
    if (!undoStack.length) return;
    redoStack.push(snapshot()); restore(undoStack.pop()); closePopover(); changed();
  }
  function redo() {
    if (!redoStack.length) return;
    undoStack.push(snapshot()); restore(redoStack.pop()); closePopover(); changed();
  }
  function meterAt(i) {
    var s = sorted(), meter = s[0].meter;
    for (var k = 0; k < s.length && s[k].i <= i; k++) meter = s[k].meter;
    return meter;
  }
  function addMarkerAt(time) {
    var i = S.nearestBeatIndex(beats, time);
    var existing = markers.filter(function (x) { return x.i === i; })[0];
    if (existing) {                      // already a marker on this beat: select it instead
      selectedId = existing.id; renderMarkers();
      if (audio.paused) openPopover(existing.id);
      return;
    }
    pushUndo();
    var m = { id: nextId++, i: i, meter: meterAt(i), label: "", conf: null, auto: false };
    markers.push(m);
    selectedId = m.id;
    changed();
    // While the song is playing, stay out of the way: no popover over the timeline.
    if (audio.paused) openPopover(m.id); else closePopover();
  }
  function removeMarker(id) {
    var m = find(id);
    if (!m || m.i === 0) return;
    pushUndo();
    markers = markers.filter(function (x) { return x.id !== id; });
    selectedId = null; closePopover(); changed();
  }
  function setMeter(id, meter) {
    var m = find(id);
    if (!m || (m.meter === meter && !m.auto)) { if (m) { m.auto = false; renderMarkers(); renderPopover(); } return; }
    pushUndo();
    m.meter = meter; m.auto = false;    // a human picked it: no longer a guess
    changed(); renderPopover();
  }
  function moveMarker(id, i) {
    var m = find(id);
    if (!m || m.i === 0) return false;
    i = Math.max(1, Math.min(beats.length - 1, i));
    if (i === m.i || occupied(i, id)) return false;
    m.i = i;
    return true;
  }

  /* ---------- layout + canvas ---------- */
  function layout() {
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
    var w = viewW, h = viewH, sl = scroller.scrollLeft;
    g.clearRect(0, 0, w, h);
    if (!beats.length) return;
    var t0 = xToTime(sl - 4), t1 = xToTime(sl + w + 4);

    // Section bands.
    for (var k = 0; k < sections.length; k++) {
      var xs = timeToX(beats[sections[k].index]) - sl;
      var xe = (k + 1 < sections.length ? timeToX(beats[sections[k + 1].index]) : timeToX(duration)) - sl;
      if (xe < 0 || xs > w) continue;
      g.fillStyle = k % 2 ? "rgba(198,161,91,0.075)" : "rgba(198,161,91,0.025)";
      g.fillRect(xs, RULER, xe - xs, h - RULER);
      // The bar where the section cue plays, just before the next marker.
      if (k + 1 < sections.length) {
        var cueIdx = sections[k + 1].index - sections[k].beatsPerBar;
        if (cueIdx >= 0) {
          var xc = timeToX(beats[cueIdx]) - sl;
          g.fillStyle = "rgba(227,198,132,0.13)";
          g.fillRect(xc, h - 26, xe - xc, 26);
          if (xe - xc > 34) { g.fillStyle = "rgba(227,198,132,0.8)"; g.font = "11px sans-serif"; g.textAlign = "left"; g.fillText("cue", xc + 4, h - 9); }
        }
      }
    }

    // Time ruler.
    g.fillStyle = "#18140f"; g.fillRect(0, 0, w, RULER);
    var steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300], step = steps[steps.length - 1];
    for (var q = 0; q < steps.length; q++) if (steps[q] * pxPerSec >= 64) { step = steps[q]; break; }
    g.font = "11px ui-monospace, Menlo, monospace"; g.textAlign = "left"; g.fillStyle = "#9c9184"; g.strokeStyle = "#3a2f20"; g.lineWidth = 1;
    for (var t = Math.max(0, Math.floor(t0 / step) * step); t <= Math.min(duration, t1); t += step) {
      var xr = Math.round(timeToX(t) - sl) + 0.5;
      g.beginPath(); g.moveTo(xr, RULER - 7); g.lineTo(xr, RULER); g.stroke();
      g.fillText(fmtTime(t, step < 1), xr + 4, 14);
    }
    g.beginPath(); g.moveTo(0, RULER + 0.5); g.lineTo(w, RULER + 0.5); g.stroke();

    // Count-in ticks.
    g.strokeStyle = "rgba(237,227,208,0.35)"; g.setLineDash([3, 3]);
    for (var c = 0; c < schedule.length && schedule[c].kind === "count"; c++) {
      var xk = Math.round(timeToX(schedule[c].time) - sl) + 0.5;
      g.beginPath(); g.moveTo(xk, h * 0.62); g.lineTo(xk, h - 28); g.stroke();
    }
    g.setLineDash([]);

    // Beat ticks and bar lines.
    var first = Math.max(0, lowerBound(beats, t0)), k2 = 0;
    var gap = beats.length > 1 ? (beats[beats.length - 1] - beats[0]) / (beats.length - 1) * pxPerSec : 10;
    g.textAlign = "left";
    for (var i = first; i < beats.length && beats[i] <= t1; i++) {
      while (k2 + 1 < sections.length && sections[k2 + 1].index <= i) k2++;
      var sec = sections[k2], pos = (i - sec.index) % sec.beatsPerBar, x = Math.round(timeToX(beats[i]) - sl) + 0.5;
      if (pos === 0) {
        var bar = (i - sec.index) / sec.beatsPerBar, barGap = gap * sec.beatsPerBar;
        var skip = barGap >= 5 ? 1 : barGap >= 2.5 ? 2 : 4;
        if (bar % skip) continue;
        g.strokeStyle = "rgba(237,227,208,0.55)"; g.lineWidth = barGap >= 9 ? 1.5 : 1;
        g.beginPath(); g.moveTo(x, h * 0.42); g.lineTo(x, h - 28); g.stroke();
        var every = barGap >= 30 ? 1 : barGap >= 15 ? 2 : barGap >= 7.5 ? 4 : 8;
        if (bar % every === 0 && barGap * every >= 22) { g.fillStyle = "rgba(156,145,132,0.9)"; g.font = "10px sans-serif"; g.fillText(String(bar + 1), x + 3, h * 0.42 + 9); }
      } else if (gap >= 4) {
        g.strokeStyle = "rgba(237,227,208,0.22)"; g.lineWidth = 1;
        g.beginPath(); g.moveTo(x, h * 0.62); g.lineTo(x, h - 28); g.stroke();
      }
    }
  }

  /* ---------- markers (DOM) ---------- */
  var markerEls = {};
  function renderMarkers() {
    var seen = {}, list = sorted(), lastX = [-1e9, -1e9];
    list.forEach(function (m) {
      var el = markerEls[m.id];
      if (!el) {
        el = document.createElement("button");
        el.className = "marker"; el.type = "button";
        el.innerHTML = '<span class="flag"></span>';
        el.dataset.id = m.id;
        markersEl.appendChild(el);
        markerEls[m.id] = el;
      }
      seen[m.id] = true;
      var x = timeToX(beats[m.i]);
      var low = m.auto && m.conf !== null && m.conf < 0.5;
      var row = x - lastX[0] >= 96 ? 0 : x - lastX[1] >= 96 ? 1 : 0;   // stagger flags that would overlap
      lastX[row] = x;
      el.style.transform = "translateX(" + x + "px)";
      el.className = "marker row-" + row + (m.i === 0 ? " fixed" : "") + (low ? " low" : "") +
        (m.id === selectedId ? " selected" : "") + (drag && drag.id === m.id && drag.moved ? " dragging" : "");
      var flag = el.firstChild;
      var text = m.meter + (low ? " ?" : "");
      if (flag.dataset.t !== text + "|" + m.label) {
        flag.dataset.t = text + "|" + m.label;
        flag.textContent = text;
        if (m.label) { var sm = document.createElement("small"); sm.textContent = m.label; flag.appendChild(sm); }
      }
      el.setAttribute("aria-label", "Marker at " + fmtTime(beats[m.i], true) + ", " + m.meter +
        (m.label ? ", " + m.label : "") + (low ? ", low confidence guess" : "") + (m.i === 0 ? ", start of song (fixed)" : ""));
      el.title = m.i === 0 ? "Start of song — click to set its time signature"
        : low ? "Guessed time signature (low confidence) — click to check it" : "Drag to move · click to edit";
    });
    Object.keys(markerEls).forEach(function (id) {
      if (!seen[id]) { markerEls[id].remove(); delete markerEls[id]; }
    });
  }

  /* ---------- popover ---------- */
  function openPopover(id) { selectedId = id; popover.hidden = false; renderMarkers(); renderPopover(); positionPopover(); }
  function closePopover() { popover.hidden = true; }
  function renderPopover() {
    var m = find(selectedId);
    if (!m) return closePopover();
    Array.prototype.forEach.call($("meters").children, function (b) { b.classList.toggle("active", b.dataset.meter === m.meter); });
    if (document.activeElement !== $("label")) $("label").value = m.label;
    $("delete-marker").disabled = m.i === 0;
    $("delete-marker").title = m.i === 0 ? "The first marker can't be deleted" : "Delete marker (Delete)";
    var hint = $("confidence-hint");
    if (m.auto && m.conf !== null && m.conf < 0.5) {
      hint.hidden = false;
      hint.textContent = "Not sure about this one (confidence " + Math.round(m.conf * 100) + "%), so it defaults to 4/4. Pick the right one.";
    } else if (m.auto && m.conf !== null) {
      hint.hidden = false; hint.textContent = "Auto-detected, confidence " + Math.round(m.conf * 100) + "%.";
    } else hint.hidden = true;
  }
  function positionPopover() {
    var m = find(selectedId);
    if (popover.hidden || !m) return;
    var x = timeToX(beats[m.i]), sl = scroller.scrollLeft, pw = popover.offsetWidth || 318;
    var left = Math.max(sl + 8, Math.min(x + 6, sl + viewW - pw - 8));
    popover.style.left = left + "px";
  }

  /* ---------- pointer: drag, click, seek, add ---------- */
  var drag = null;
  function eventTime(e) {
    var rect = scroller.getBoundingClientRect();
    return xToTime(e.clientX - rect.left + scroller.scrollLeft);
  }
  function snapIndex(time, toDownbeat) {
    if (toDownbeat && downbeats.length) {
      var d = downbeats[S.nearestBeatIndex(downbeats, time)];
      return S.nearestBeatIndex(beats, d);
    }
    return S.nearestBeatIndex(beats, time);
  }
  markersEl.addEventListener("pointerdown", function (e) {
    var el = e.target.closest(".marker");
    if (!el || e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    var id = Number(el.dataset.id), m = find(id);
    drag = { id: id, startX: e.clientX, moved: false, before: snapshot(), fixed: m.i === 0, el: el, pointerId: e.pointerId };
    el.setPointerCapture(e.pointerId);
    el.focus({ preventScroll: true });
  });
  markersEl.addEventListener("pointermove", function (e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (!drag.moved) {
      if (drag.fixed || Math.abs(e.clientX - drag.startX) < 6) return;
      drag.moved = true; closePopover(); selectedId = drag.id;
    }
    drag.clientX = e.clientX; drag.shift = e.shiftKey;
    dragTo();
    if (!drag.raf) drag.raf = requestAnimationFrame(edgeScroll);
  });
  function dragTo() {
    var rect = scroller.getBoundingClientRect();
    var time = xToTime(drag.clientX - rect.left + scroller.scrollLeft);
    if (moveMarker(drag.id, snapIndex(time, drag.shift))) changed({ transient: true });
    else renderMarkers();
  }
  function edgeScroll() {               // keep scrolling while the pointer rests near an edge
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

  popover.addEventListener("pointerdown", function (e) { e.stopPropagation(); });
  popover.addEventListener("dblclick", function (e) { e.stopPropagation(); });
  popover.addEventListener("click", function (e) { e.stopPropagation(); });
  $("meters").addEventListener("click", function (e) {
    var b = e.target.closest("button");
    if (b) setMeter(selectedId, b.dataset.meter);
  });
  var labelBefore = null;
  $("label").addEventListener("focus", function () { labelBefore = snapshot(); });
  $("label").addEventListener("input", function () {
    var m = find(selectedId);
    if (!m) return;
    m.label = $("label").value.slice(0, 40);
    renderMarkers();
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

  // Timeline background: click seeks, double-click adds a marker.
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
    if (!popover.hidden) { closePopover(); selectedId = null; renderMarkers(); return; }  // first click just dismisses
    if (selectedId !== null) { selectedId = null; renderMarkers(); }
    seek(eventTime(e));
  });
  scroller.addEventListener("dblclick", function (e) {
    if (e.target.closest(".marker") || e.target.closest(".popover")) return;
    addMarkerAt(eventTime(e));
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
    z = Math.max(1, Math.min(24, z));
    if (anchorX === undefined) anchorX = viewW / 2;
    var t = xToTime(scroller.scrollLeft + anchorX);
    zoom = z; $("zoom").value = z;
    layout();
    scroller.scrollLeft = timeToX(t) - anchorX;
    requestDraw();
  }
  $("zoom").addEventListener("input", function () {
    var anchor = playheadVisible() ? timeToX(songTime()) - scroller.scrollLeft : undefined;
    setZoom(parseFloat($("zoom").value), anchor);
  });

  /* ---------- playback + live click preview ---------- */
  var ctx = null, master = null, pending = [], nextEvent = 0, clockOffset = null;
  function ensureCtx() {
    if (!ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      ctx = new AC({ latencyHint: "interactive" });
      master = ctx.createGain(); master.gain.value = 0.6; master.connect(ctx.destination);
    }
    if (ctx.state === "suspended") ctx.resume();
  }
  function songTime() {
    if (!audio.paused && ctx && clockOffset !== null) return Math.min(duration, ctx.currentTime + clockOffset);
    return audio.currentTime;
  }
  function cancelPending() {
    var now = ctx ? ctx.currentTime : 0;
    pending.forEach(function (p) { if (p.when > now) { try { p.osc.stop(); p.osc.disconnect(); } catch (e) { /* already done */ } } });
    pending = [];
  }
  function resync() { cancelPending(); clockOffset = null; }
  function firstEventAt(t) {
    var lo = 0, hi = schedule.length;
    while (lo < hi) { var mid = (lo + hi) >> 1; if (schedule[mid].time < t) lo = mid + 1; else hi = mid; }
    return lo;
  }
  function playClick(kind, when) {
    var s = S.SOUNDS[kind], osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.type = "sine"; osc.frequency.value = s[0];
    gain.gain.setValueAtTime(s[2], when);
    gain.gain.exponentialRampToValueAtTime(s[2] * Math.exp(-S.DECAY * s[1]), when + s[1]);
    osc.connect(gain); gain.connect(master);
    osc.start(when); osc.stop(when + s[1]);
    pending.push({ osc: osc, when: when });
    if (pending.length > 64) pending.splice(0, 32);
  }
  function tick() {
    if (!ctx || audio.paused || audio.seeking) return;
    // Follow the <audio> clock through the steadier AudioContext clock.
    var measured = audio.currentTime - ctx.currentTime;
    if (clockOffset === null || Math.abs(measured - clockOffset) > 0.06) {
      cancelPending();
      clockOffset = measured;
      nextEvent = firstEventAt(audio.currentTime - 0.005);
    } else clockOffset += 0.08 * (measured - clockOffset);
    if (mode === "song") return;
    var horizon = ctx.currentTime + 0.12;
    while (nextEvent < schedule.length) {
      var ev = schedule[nextEvent], when = ev.time - clockOffset;
      if (when > horizon) break;
      if (when > ctx.currentTime - 0.03) playClick(ev.kind, Math.max(when, ctx.currentTime));
      nextEvent++;
    }
  }
  setInterval(tick, 25);

  function seek(t) {
    t = Math.max(0, Math.min(duration - 0.01, t));
    audio.currentTime = t; resync(); updatePlayhead(true);
  }
  function togglePlay() {
    ensureCtx();
    if (audio.paused) { resync(); audio.play().catch(function () { showError("The browser blocked playback. Click Play again."); }); }
    else audio.pause();
  }
  audio.addEventListener("play", function () { setPlayIcon(true); resync(); });
  audio.addEventListener("pause", function () { setPlayIcon(false); resync(); });
  audio.addEventListener("seeked", resync);
  audio.addEventListener("ended", function () { setPlayIcon(false); resync(); });
  audio.addEventListener("error", function () { showError("Could not load the song audio for playback."); });
  function setPlayIcon(playing) {
    $("play-icon").setAttribute("d", playing ? "M6 4.5h4.5v15H6zM13.5 4.5H18v15h-4.5z" : "M7 4.5v15l13-7.5z");
    $("play").setAttribute("aria-label", playing ? "Pause" : "Play");
  }
  function setMode(next) {
    mode = next;
    audio.muted = mode === "click";
    audio.volume = mode === "both" ? 0.7 : 1;
    Array.prototype.forEach.call(document.querySelectorAll(".segmented button"), function (b) {
      b.setAttribute("aria-checked", String(b.dataset.mode === mode));
    });
    if (mode === "song") cancelPending(); else clockOffset = null;
  }

  /* ---------- playhead + readouts ---------- */
  var lastBeatShown = -1, ledOff = 0;
  function playheadVisible() {
    var x = timeToX(songTime()) - scroller.scrollLeft;
    return x >= 0 && x <= viewW;
  }
  function updatePlayhead(force) {
    var t = songTime(), x = timeToX(t);
    playheadEl.style.transform = "translateX(" + x + "px)";
    if (!audio.paused && zoom > 1 && !drag && !bgDown && popover.hidden) {
      // Follow smoothly: once the playhead passes 40% of the view, the timeline scrolls under it.
      var rel = x - scroller.scrollLeft;
      if (rel < 0 || rel > viewW) scroller.scrollLeft = x - viewW * 0.4;
      else if (rel > viewW * 0.4) scroller.scrollLeft += Math.min(rel - viewW * 0.4, 40);
    } else if (force && zoom > 1) {
      var r = x - scroller.scrollLeft;
      if (r > viewW || r < 0) scroller.scrollLeft = x - viewW * 0.3;
    }
    $("time").textContent = fmtTime(t, true);
    if (!beats.length) return;
    var i = beatAtOrBefore(t);
    if (t < beats[0]) { $("position").textContent = "Count-in"; i = -1; }
    else {
      var k = 0;
      while (k + 1 < sections.length && sections[k + 1].index <= i) k++;
      var off = i - sections[k].index, n = sections[k].beatsPerBar;
      $("position").textContent = "Bar " + (Math.floor(off / n) + 1) + " · beat " + (off % n + 1);
      if (i !== lastBeatShown && !audio.paused) {
        $("led").className = "led on" + (off % n === 0 ? " down" : "");
        ledOff = performance.now() + 90;
      }
    }
    lastBeatShown = i;
    if (ledOff && performance.now() > ledOff) { $("led").className = "led"; ledOff = 0; }
  }
  (function loop() { updatePlayhead(false); requestAnimationFrame(loop); })();

  /* ---------- keyboard ---------- */
  document.addEventListener("keydown", function (e) {
    var tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" && e.target.type !== "range") return;
    var mod = e.ctrlKey || e.metaKey, key = e.key;
    if (mod && key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (mod && key.toLowerCase() === "y") { e.preventDefault(); redo(); return; }
    if (mod || e.altKey) return;
    if (key === " " || key === "Spacebar") { e.preventDefault(); togglePlay(); }
    else if (key === "m" || key === "M") { e.preventDefault(); addMarkerAt(songTime()); }
    else if (key === "Delete" || key === "Backspace") { if (selectedId !== null) { e.preventDefault(); removeMarker(selectedId); } }
    else if (key === "Escape") { closePopover(); selectedId = null; renderMarkers(); }
    else if (key === "Enter" && tag === "button" && e.target.classList.contains("marker")) { e.preventDefault(); openPopover(Number(e.target.dataset.id)); }
    else if (key === "ArrowLeft" || key === "ArrowRight") {
      var dir = key === "ArrowLeft" ? -1 : 1, m = find(selectedId);
      e.preventDefault();
      if (m && m.i !== 0) {
        var before = snapshot(), target = m.i + dir;
        if (e.shiftKey) target = m.i + dir * S.beatsPerBar(meterAt(Math.max(0, m.i - 1)));
        var guard = 0;
        while (occupied(target, m.id) && guard++ < 8) target += dir;
        if (moveMarker(m.id, target)) { undoStack.push(before); redoStack.length = 0; changed(); positionPopover(); }
      } else if (!m) seek(songTime() + dir * 5);
    }
  });
  $("play").addEventListener("click", togglePlay);
  $("add-marker").addEventListener("click", function () { addMarkerAt(songTime()); });
  $("undo").addEventListener("click", undo);
  $("redo").addEventListener("click", redo);
  Array.prototype.forEach.call(document.querySelectorAll(".segmented button"), function (b) {
    b.addEventListener("click", function () { setMode(b.dataset.mode); });
  });
  $("reset").addEventListener("click", function () {
    pushUndo(); markers = fromAnalysis(detected); selectedId = null; closePopover(); changed();
  });

  /* ---------- render + download ---------- */
  function showError(message) { $("error").textContent = message; $("error").hidden = !message; }
  function markStale() {
    var box = $("downloads");
    if (!box.hidden && !box.classList.contains("stale")) {
      box.classList.add("stale");
      $("render-status").textContent = "Markers changed since this render. Press Download click track again.";
    }
  }
  $("download").addEventListener("click", function () {
    var btn = $("download"), box = $("downloads");
    btn.disabled = true; btn.textContent = "Rendering…"; showError("");
    fetch("/render/" + jobId, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markers: exportMarkers() }),
    }).then(function (res) {
      return res.json().then(function (body) { if (!res.ok) throw new Error(body.detail || "Rendering failed."); return body; });
    }).then(function (body) {
      var bust = "?t=" + Date.now();
      $("dl-click").href = body.click + bust; $("dl-mix").href = body.mix + bust;
      box.hidden = false; box.classList.remove("stale");
      $("render-status").textContent = "Ready. These match the preview you just heard.";
    }).catch(function (err) { showError(err.message); })
      .then(function () { btn.disabled = false; btn.textContent = "Download click track"; });
  });

  /* ---------- boot ---------- */
  function fromAnalysis(list) {
    var out = [], id = 1, used = {};
    list.forEach(function (m, k) {
      var i = k === 0 ? 0 : S.nearestBeatIndex(beats, m.time);
      if (used[i]) return;
      used[i] = true;
      out.push({ id: id++, i: i, meter: m.meter, label: m.label || "",
        conf: typeof m.meter_confidence === "number" ? m.meter_confidence : null, auto: true });
    });
    nextId = id;
    return out;
  }
  fetch("/job/" + jobId + "/analysis").then(function (res) {
    if (!res.ok) throw new Error("This job has expired. Upload the song again.");
    return res.json();
  }).then(function (a) {
    beats = a.beats; downbeats = a.downbeats || []; duration = a.duration; detected = a.markers;
    $("bpm").textContent = Math.round(a.bpm * 10) / 10 + " BPM";
    $("total").textContent = fmtTime(duration);
    markers = fromAnalysis(detected);
    try {
      var saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
      if (Array.isArray(saved) && saved.length && saved.every(function (m) { return m.i >= 0 && m.i < beats.length; })) {
        markers = saved;
        nextId = markers.reduce(function (n, m) { return Math.max(n, m.id + 1); }, 1);
      }
    } catch (e) { /* ignore */ }
    sections = S.resolveMarkers(beats, exportMarkers());
    schedule = S.buildClickSchedule(beats, exportMarkers(), duration);
    setMode("both");
    layout();
  }).catch(function (err) { showError(err.message); });

  if (window.ResizeObserver) new ResizeObserver(layout).observe(frame);
  else window.addEventListener("resize", layout);

  // Small hook for automated tests and debugging.
  window.DCEditor = {
    markers: function () { return exportMarkers(); },
    schedule: function () { return schedule; },
    songTime: songTime,
  };
})();
