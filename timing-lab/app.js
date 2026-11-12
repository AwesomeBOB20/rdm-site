/* Timing Lab - the live page (Phase 2). See README.md for the contract.
 *
 * ONE CLOCK. Every sound this page plays is scheduled on the AudioContext timeline, and the mic is recorded
 * by an AudioWorklet stamping each block with its frame on that SAME timeline (recorder-worklet.js). So
 * "where a note should be in the recording" is: scheduled time + the device's round-trip delay, and that
 * delay is the one number calibration measures - speaker, air, mic and both buffers together.
 *
 * Detection runs AFTER a take, on the whole recording (detector.js), where it is most accurate. */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var S = { ctx: null, stream: null, node: null, analyser: null, offset: null, accMs: null, calOut: null, take: null, pads: null };

  /* ---------- microphone ---------- */
  function constraints(deviceId) {
    // Every "helpful" phone/browser process OFF: echo cancellation, noise suppression and auto-gain all
    // smear or gate a stick's attack, and auto-gain makes a soft tap after an accent vanish.
    var a = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 };
    if (deviceId) a.deviceId = { exact: deviceId };
    return { audio: a, video: false };
  }
  /* ?loopback=23 - a TEST switch for a browser with no speaker and no mic: the page's own output is fed
     straight into its "mic" through a known delay (plus a little hiss), so calibration must read back that
     delay and the robot test must read back its hidden timings exactly. It checks everything except the
     air: scheduling, the recorder's clock, alignment and detection. */
  var LOOP = (function () { var m = /[?&]loopback=([\d.]+)/.exec(location.search); return m ? +m[1] : null; })();
  async function openMic(deviceId) {
    if (S.stream) S.stream.getTracks().forEach(function (t) { t.stop(); });
    if (LOOP == null) S.stream = await navigator.mediaDevices.getUserMedia(constraints(deviceId));
    if (!S.ctx) {
      S.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "interactive" });
      await S.ctx.audioWorklet.addModule("recorder-worklet.js");
      S.out = S.ctx.createGain(); S.out.connect(S.ctx.destination);    // everything the page plays goes through here
    }
    await S.ctx.resume();
    var src;
    if (LOOP != null) {
      var dl = S.ctx.createDelay(1); dl.delayTime.value = LOOP / 1000;
      var nb = S.ctx.createBuffer(1, S.ctx.sampleRate * 2, S.ctx.sampleRate), nd = nb.getChannelData(0);
      for (var i = 0; i < nd.length; i++) nd[i] = (Math.random() * 2 - 1) * 0.0005;   // ~ -66 dB of hiss
      var ns = S.ctx.createBufferSource(); ns.buffer = nb; ns.loop = true; ns.start();
      src = S.ctx.createGain(); S.out.connect(dl); dl.connect(src); ns.connect(src);
    } else src = S.ctx.createMediaStreamSource(S.stream);
    if (S.node) try { S.node.disconnect(); } catch (e) {}
    S.node = new AudioWorkletNode(S.ctx, "rdm-recorder", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: "explicit" });
    var mute = S.ctx.createGain(); mute.gain.value = 0;              // keeps the worklet pulled, plays nothing
    src.connect(S.node); S.node.connect(mute); mute.connect(S.ctx.destination);
    S.analyser = S.ctx.createAnalyser(); S.analyser.fftSize = 1024; src.connect(S.analyser);
    meterLoop();
    if (LOOP == null) { await listDevices(); showDevice(); }
    else { $("devInfo").textContent = "LOOPBACK TEST: output fed to the recorder through " + LOOP + " ms"; $("micMsg").textContent = "Loopback test mode (no real mic)."; }
    $("calBtn").disabled = false;
    S.offset = null; $("calMsg").textContent = ""; $("playBtn").disabled = false; $("hearBtn").disabled = false; $("robotBtn").disabled = true;
    selfTimedNote();
  }
  async function listDevices() {
    var devs = (await navigator.mediaDevices.enumerateDevices()).filter(function (d) { return d.kind === "audioinput"; });
    var sel = $("micSel"), cur = S.stream.getAudioTracks()[0].getSettings().deviceId;
    sel.innerHTML = "";
    devs.forEach(function (d, i) { var o = document.createElement("option"); o.value = d.deviceId; o.textContent = d.label || ("Mic " + (i + 1)); if (d.deviceId === cur) o.selected = true; sel.appendChild(o); });
    sel.hidden = devs.length < 2;
  }
  var meterOn = false;
  function meterLoop() {
    if (meterOn) return; meterOn = true;
    var buf = new Float32Array(1024);
    (function tick() {
      S.analyser.getFloatTimeDomainData(buf);
      var pk = 0; for (var i = 0; i < buf.length; i++) pk = Math.max(pk, Math.abs(buf[i]));
      var db = 20 * Math.log10(pk + 1e-9);
      $("meter").style.width = Math.max(0, Math.min(100, (db + 60) / 60 * 100)) + "%";
      $("meter").style.background = pk > 0.98 ? "#c0392b" : "";
      requestAnimationFrame(tick);
    })();
  }
  function showDevice() {
    var t = S.stream.getAudioTracks()[0], s = t.getSettings ? t.getSettings() : {};
    var off = function (v) { return v === false ? "off" : v === true ? "ON (asked for off)" : "unknown"; };
    $("devInfo").textContent = [
      "mic: " + (t.label || "(no name)"),
      "echo cancellation " + off(s.echoCancellation) + ", noise suppression " + off(s.noiseSuppression) + ", auto gain " + off(s.autoGainControl),
      "mic rate " + (s.sampleRate || "?") + " Hz, audio engine " + S.ctx.sampleRate + " Hz",
      "reported latency: base " + ms(S.ctx.baseLatency) + ", output " + ms(S.ctx.outputLatency) + " (calibration measures the real one)",
      navigator.userAgent
    ].join("\n");
    var bad = s.echoCancellation === true || s.noiseSuppression === true || s.autoGainControl === true;
    $("micMsg").innerHTML = bad
      ? '<span class="bad">This browser kept some voice processing on. Results may be off; try another browser on this device.</span>'
      : "Mic ready, voice processing off. Quiet room; phone or mic an arm's length from the drum, or closer.";
  }
  function ms(v) { return v == null ? "?" : (v * 1000).toFixed(1) + " ms"; }

  /* ---------- recording ---------- */
  function record(seconds) {
    return new Promise(function (resolve) {
      var chunks = [], port = S.node.port;
      port.onmessage = function (e) {
        if (e.data.stopped) {
          port.onmessage = null;
          if (!chunks.length) return resolve({ x: new Float32Array(0), frame0: 0, gaps: 0 });
          var frame0 = chunks[0].frame, last = chunks[chunks.length - 1], n = last.frame + last.data.length - frame0;
          var x = new Float32Array(n), gaps = 0, expect = frame0;
          chunks.forEach(function (c) { if (c.frame !== expect) gaps++; x.set(c.data, c.frame - frame0); expect = c.frame + c.data.length; });
          resolve({ x: x, frame0: frame0, gaps: gaps });
        } else chunks.push(e.data);
      };
      port.postMessage("start");
      setTimeout(function () { port.postMessage("stop"); }, seconds * 1000);
    });
  }

  /* ---------- sounds ---------- */
  var clickBuf = null;
  function click() {
    if (clickBuf) return clickBuf;
    var sr = S.ctx.sampleRate, n = Math.round(sr * 0.012), b = S.ctx.createBuffer(1, n, sr), d = b.getChannelData(0);
    for (var i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (sr * 0.0012)) * 0.95;   // a sharp tick
    return (clickBuf = b);
  }
  /* THE PLAY-ALONG CLICK IS A BEEP AT ONE PITCH (see notchAll in detector.js): 2 kHz, a 40 ms smooth
     (Hann) swell. The SHAPE is the point, measured 2026-09-27 on a beep landing right before a late hit:
       a hard-edged beep                -> its edge is a click at every pitch: 18 false hits in 53
       30 ms, 6 ms fades                -> 12 of 20 late hits read as the beep instead (up to 5.7 ms off)
       Hann 15-25 ms                    -> 9-10 of 20 wrong
       Hann 30 ms                       -> accents right, 3 of 20 soft taps wrong
       Hann 40 ms                       -> 0 of 20 wrong, even a soft tap under a beep 3x louder (0.42 ms)
     What leaks past the filter is the beep's spread either side of its pitch, and only a long smooth
     swell keeps that spread narrow enough for the filter to take all of it. */
  var BEEP_HZ = 2000, NOTCH = [2000, 4000, 6000], beepBuf = null;
  function beep() {
    if (beepBuf) return beepBuf;
    var sr = S.ctx.sampleRate, n = Math.round(sr * 0.040), b = S.ctx.createBuffer(1, n, sr), d = b.getChannelData(0);
    for (var i = 0; i < n; i++) d[i] = 0.8 * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1))) * Math.sin(2 * Math.PI * BEEP_HZ * i / sr);
    return (beepBuf = b);
  }
  function play(buf, when, gain) {
    var s = S.ctx.createBufferSource(); s.buffer = buf;
    var g = S.ctx.createGain(); g.gain.value = gain == null ? 1 : gain;
    s.connect(g); g.connect(S.out); s.start(when);
  }
  /* THE ONLINE COPY HAS NO PAD RECORDINGS (2026-11-11). Those are the app's own paid sounds, kept in the private vault, and the website
     is a public repository. So where they cannot be fetched (or with ?synthpads=1) the page makes its own pad hits: a burst of noise
     that starts in a fraction of a millisecond and dies away, louder and longer for an accent. What the listener needs from the
     phone's own notes is a sharp start at a known moment and a level, and these have both. */
  function synthPads() {
    /* a short click of noise for the stick's attack, then a smooth ring of three tones dying away (a pure noise tail wobbles by
       several dB from one 2 ms window to the next, and the play-along mode compares levels: with it 13 to 15 notes in 42 went unread) */
    var sr = S.ctx.sampleRate, seed = 12345, rnd = function () { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1; };
    function one(tau, tap, k) {
      var n = Math.round(sr * 0.16), b = S.ctx.createBuffer(1, n, sr), d = b.getChannelData(0), pk = 0, f = [1150 + 40 * k, 1930 + 55 * k, 3270 + 70 * k];
      for (var i = 0; i < n; i++) {
        var t = i / sr, ring = Math.exp(-t / tau) * (Math.sin(2 * Math.PI * f[0] * t) + 0.6 * Math.sin(2 * Math.PI * f[1] * t) + 0.35 * Math.sin(2 * Math.PI * f[2] * t));
        var click = rnd() * Math.exp(-t / 0.0012);
        d[i] = (ring + 1.2 * click) * Math.min(1, t / 0.0002); pk = Math.max(pk, Math.abs(d[i]));
      }
      for (i = 0; i < n; i++) d[i] /= pk;
      return { buf: b, start: 0, tap: tap, k: k };
    }
    return [one(0.020, false, 0), one(0.022, false, 1), one(0.018, false, 2), one(0.011, true, 0), one(0.012, true, 1), one(0.010, true, 2), one(0.016, false, 3), one(0.015, false, 4)];
  }
  async function pads() {
    if (S.pads) return S.pads;
    if (/[?&]synthpads=1/.test(location.search)) return (S.pads = synthPads());
    var names = ["click_accent_1", "click_accent_2", "click_accent_3", "click_tap_1", "click_tap_2", "click_tap_3", "click_mid_1", "click_mid_2"];
    try { var probe = await fetch("../shared/samples/invader-pad/" + names[0] + ".wav", { method: "HEAD" }); if (!probe.ok) return (S.pads = synthPads()); }
    catch (e) { return (S.pads = synthPads()); }
    S.pads = await Promise.all(names.map(async function (n) {
      var r = await fetch("../shared/samples/invader-pad/" + n + ".wav");
      var b = await S.ctx.decodeAudioData(await r.arrayBuffer());
      var d = b.getChannelData(0), pk = 0; for (var i = 0; i < d.length; i++) pk = Math.max(pk, Math.abs(d[i]));
      for (i = 0; i < d.length; i++) d[i] /= pk;              // the files are recorded at very different levels
      var st = 0; while (st < d.length && Math.abs(d[st]) <= 0.02) st++;
      /* the recordings carry a sliver of their own room hiss before the attack (the soft taps worst: -45 dB
         under a quiet hit). Played by the robot / test drummer it STARTS abruptly ~2 ms early and read as
         the hit's start - a ~1 ms artefact of the sample, not of drumming (live test 2026-09-27). Silenced,
         with a 0.2 ms fade into the attack, exactly as the offline test audio does (dev/corpus.js). */
      var sr0 = b.sampleRate, edge = Math.max(0, st - Math.round(sr0 * 0.0002));
      for (i = 0; i < edge; i++) d[i] = 0;
      for (i = edge; i < st; i++) d[i] *= (i - edge) / Math.max(1, st - edge);
      return { buf: b, start: st / b.sampleRate, tap: n.indexOf("tap") >= 0 };
    }));
    return S.pads;
  }

  /* ---------- calibration ---------- */
  var CAL_N = 16;
  async function calibrate() {
    var out = document.querySelector('input[name="out"]:checked').value;
    $("calBtn").disabled = true; $("calMsg").textContent = "Listening... stay quiet.";
    var ctx = S.ctx, sr = ctx.sampleRate, t0 = ctx.currentTime + 0.5, times = [];
    for (var k = 0; k < CAL_N; k++) times.push(t0 + k * 0.33 + Math.random() * 0.08);   // uneven, so an echo can never line up with the next click
    var rec = record(times[CAL_N - 1] - ctx.currentTime + 0.9);
    times.forEach(function (t) { play(click(), t, 1); });
    var r = await rec;
    var hits = RDMOnsets.detect(r.x, sr);
    // every (click, hit) delay between 0 and 600 ms; the device's delay is the one most clicks agree on
    var cands = [];
    times.forEach(function (t, k) {
      var sched = t * sr - r.frame0;
      hits.forEach(function (h) { var d = h.sample - sched; if (d >= 0 && d < 0.6 * sr) cands.push({ k: k, d: d }); });
    });
    var best = null;
    cands.forEach(function (c) {
      var seen = {}, n = 0;
      cands.forEach(function (o) { if (Math.abs(o.d - c.d) < 0.003 * sr && !seen[o.k]) { seen[o.k] = 1; n++; } });
      if (!best || n > best.n) best = { d: c.d, n: n };
    });
    if (!best || best.n < CAL_N * 0.75) {
      /* SAY WHICH FAILURE IT WAS (Anthony, 2026-09-27, first try on his laptop: "0 of 16 ... its trying to
         hear itself??"). Loudest thing the mic heard while the clicks played, against the room before them:
         nothing at all means the sound never reached the mic (headphones, or the laptop's own echo
         cancellation deleting its speaker output); something heard but at no steady delay means noise. */
      var pre = 0, dur = 0, a0 = Math.round((times[0] * sr - r.frame0)), i2;
      for (i2 = 0; i2 < Math.max(0, a0 - 200); i2++) pre = Math.max(pre, Math.abs(r.x[i2]));
      for (i2 = Math.max(0, a0); i2 < r.x.length; i2++) dur = Math.max(dur, Math.abs(r.x[i2]));
      var rise = 20 * Math.log10((dur + 1e-9) / (pre + 1e-9));
      var why = rise < 6
        ? "The mic heard <b>nothing</b> while the clicks played (loudest sound only " + rise.toFixed(0) + " dB over the room). Either headphones are connected, the wrong mic is picked above, or the laptop is cancelling its own speaker sound out of the mic (Windows: Settings &gt; System &gt; Sound &gt; your microphone &gt; turn <b>Audio enhancements</b> / <b>Voice clarity</b> off)."
        : "The mic heard sound (" + rise.toFixed(0) + " dB over the room) but not the clicks at a steady delay (" + (best ? best.n : 0) + " of " + CAL_N + " lined up). Quieter room, volume up, and try again.";
      $("calMsg").innerHTML = '<span class="bad">' + why + "</span>" + (out !== "speaker" ? " Hold the " + (out === "bluetooth" ? "earbud" : "earcup") + " right against the mic." : "");
      $("calBtn").disabled = false; return;
    }
    var devs = [];
    times.forEach(function (t, k) {
      var near = cands.filter(function (c) { return c.k === k && Math.abs(c.d - best.d) < 0.003 * sr; });
      if (near.length) devs.push(near.sort(function (a, b) { return Math.abs(a.d - best.d) - Math.abs(b.d - best.d); })[0].d);
    });
    devs.sort(function (a, b) { return a - b; });
    var med = devs[Math.floor(devs.length / 2)];
    var spread = devs.map(function (d) { return Math.abs(d - med) / sr * 1000; });
    var maxDev = Math.max.apply(null, spread);
    S.offset = med; S.accMs = Math.max(0.5, Math.ceil(maxDev * 2 * 2) / 2); S.calOut = out;
    $("calMsg").innerHTML = '<span class="ok">Device delay <b>' + (med / sr * 1000).toFixed(1) + " ms</b>, steady to within <b>" + maxDev.toFixed(2) +
      " ms</b> (" + devs.length + " of " + CAL_N + " clicks).</span> Strictest this device can judge: <b>" + S.accMs + " ms</b>." +
      (r.gaps ? ' <span class="bad">' + r.gaps + " audio dropouts during calibration.</span>" : "");
    $("calBtn").disabled = false; $("playBtn").disabled = false; $("robotBtn").disabled = out !== "speaker";
    $("strict").min = S.accMs; if (+$("strict").value < S.accMs) $("strict").value = S.accMs;
  }

  /* ---------- exercises: something to read while you play (Anthony, 2026-09-27: "you need to add notes
     that I can play along with so that I can actually have something to reference playing to") ----------
     Each exercise is one bar of four beats, repeated. Drawn by the tools' own renderer (shared/rdm-vexflow.js)
     so it reads exactly like Playalongs, with R/L sticking under it; the cursor and the results sit on the
     same note positions the renderer reports. */
  var BEAT = {
    q: { notes: [1] }, e: { notes: [0.5, 0.5] }, t: { notes: [1 / 3, 1 / 3, 1 / 3], tup: 3 },
    s: { notes: [0.25, 0.25, 0.25, 0.25] }, gal: { notes: [0.5, 0.25, 0.25] }, rgal: { notes: [0.25, 0.25, 0.5] }
  };
  var EXERCISES = [
    { id: "q", name: "Quarter notes", beats: ["q", "q", "q", "q"] },
    { id: "e", name: "8th notes", beats: ["e", "e", "e", "e"] },
    { id: "t", name: "Triplets", beats: ["t", "t", "t", "t"] },
    { id: "s", name: "16th notes", beats: ["s", "s", "s", "s"] },
    { id: "acc", name: "16ths, accent on the beat", beats: ["s", "s", "s", "s"], accentFirst: true },
    { id: "gal", name: "8th + two 16ths", beats: ["gal", "gal", "gal", "gal"] },
    { id: "rgal", name: "Two 16ths + 8th", beats: ["rgal", "rgal", "rgal", "rgal"] },
    { id: "ladder", name: "Ladder: quarter, 8ths, triplets, 16ths", beats: ["q", "e", "t", "s"] }
  ];
  function durOf(len, tup) { return tup ? "8" : len === 1 ? "q" : len === 0.5 ? "8" : "16"; }
  function buildExercise(ex, bars) {
    var measures = [], times = [], accents = [], stick = 0;
    for (var m = 0; m < bars; m++) {
      var events = [], beams = [], tuplets = [];
      ex.beats.forEach(function (key, bi) {
        var b = BEAT[key], idx = [], at = m * 4 + bi;
        b.notes.forEach(function (len, k) {
          var acc = !!ex.accentFirst && k === 0;
          idx.push(events.length);
          events.push({ rest: false, beats: len, dur: durOf(len, b.tup), dots: 0, step: "c", oct: 5, head: "normal", heads: null,
            accent: acc, marcato: false, tenuto: false, staccato: false, roll: 0, buzz: false, flam: false,
            graces: null, stick1: (stick++ % 2) ? "L" : "R", stick2: null, dynamic: null });
          times.push(at); accents.push(acc); at += len;
        });
        if (idx.length > 1) beams.push(idx);
        if (b.tup) tuplets.push({ idx: idx, num: 3, inSpaceOf: 2, bracket: false, show: true });
      });
      measures.push({ timeSig: m === 0 ? [4, 4] : null, repeatStart: false, repeatEndTimes: 0, events: events,
                      beams: beams, tuplets: tuplets, wedges: [], extraVoices: [] });
    }
    return { ex: ex, bars: bars, rdm: { measures: measures }, times: times, accents: accents };
  }
  var SHEET = null, CURSOR = null;
  // ONE cursor element, re-attached after every draw: the renderer clears the box it draws into
  function cursorEl() { if (!CURSOR) CURSOR = $("cursor"); return CURSOR; }
  function drawSheet() {
    var ex = EXERCISES.filter(function (x) { return x.id === $("ex").value; })[0] || EXERCISES[0];
    var bars = Math.max(1, Math.min(8, +$("bars").value || 2)), host = $("sheet");
    var inner = $("sheetInner");
    if (!inner) { inner = document.createElement("div"); inner.id = "sheetInner"; inner.style.position = "relative"; host.appendChild(inner); }
    var built = buildExercise(ex, bars);
    built.anchors = [];
    SHEET = built;
    if (!window.RDMRender) { inner.textContent = "Notation could not load (offline?)."; return; }
    var out = window.RDMRender.render(built.rdm, inner, { width: Math.max(280, inner.clientWidth || host.clientWidth - 8) });
    built.rdm.measures.forEach(function (mm, mi) { mm.events.forEach(function (_, ei) { built.anchors.push(out.notes[mi] && out.notes[mi][ei]); }); });
    var cur = cursorEl(); inner.appendChild(cur); cur.style.display = "none";
  }
  function clearMarks() { document.querySelectorAll("#sheetInner .mark, #sheetInner .mlabel").forEach(function (el) { el.remove(); }); }

  // the cursor rides the AUDIO clock, so it sits on the note being heard, not wherever the screen got to
  var cursorRun = 0;
  function runCursor(P, beat, built, endT) {
    var run = ++cursorRun, cur = cursorEl();
    (function tick() {
      if (run !== cursorRun) return;
      var now = S.ctx.currentTime - (S.ctx.outputLatency || 0), pos = (now - P) / beat, i = -1;
      for (var k = 0; k < built.times.length; k++) if (built.times[k] <= pos + 1e-6) i = k;
      var a = i >= 0 ? built.anchors[i] : null;
      if (a && pos < built.bars * 4) {
        cur.style.display = "block"; cur.style.left = a.x + "px"; cur.style.top = a.cTop + "px"; cur.style.height = Math.max(20, a.cBot - a.cTop) + "px";
      } else cur.style.display = "none";
      if (S.ctx.currentTime < endT) requestAnimationFrame(tick); else cur.style.display = "none";
    })();
  }

  // Hear it: the exercise on pad sounds, once, with the count-in - so you know what it should sound like
  async function hear() {
    $("hearBtn").disabled = true; drawSheet(); clearMarks();
    var P0 = await pads(), taps = P0.filter(function (p) { return p.tap; }), accs = P0.filter(function (p) { return !p.tap; });
    var built = SHEET, beat = 60 / (+$("bpm").value || 90), t0 = S.ctx.currentTime + 0.3, P = t0 + 4 * beat, end = P + built.bars * 4 * beat;
    for (var k = 0; k < 4; k++) play(beep(), t0 + k * beat, k === 0 ? 1 : 0.6);
    built.times.forEach(function (bt, i) {
      var pool = built.accents[i] ? accs : taps, pad = pool[i % pool.length];
      play(pad.buf, P + bt * beat - pad.start, built.accents[i] ? 0.9 : 0.35);
    });
    var cur = cursorEl(), run = ++cursorRun;
    (function tick() {
      if (run !== cursorRun) return;
      var pos = (S.ctx.currentTime - (S.ctx.outputLatency || 0) - P) / beat;
      placeCursor(built, pos >= 0 && pos < built.bars * 4 ? pos : -1);
      if (S.ctx.currentTime < end + 0.2) requestAnimationFrame(tick); else cur.style.display = "none";
    })();
    setTimeout(function () { $("hearBtn").disabled = false; }, (end - S.ctx.currentTime + 0.3) * 1000);
  }
  function placeCursor(built, pos) {
    var cur = cursorEl(), i = -1;
    if (pos >= 0) for (var k = 0; k < built.times.length; k++) if (built.times[k] <= pos + 1e-6) i = k;
    var a = i >= 0 ? built.anchors[i] : null;
    if (!a) { cur.style.display = "none"; return; }
    cur.style.display = "block"; cur.style.left = a.x + "px"; cur.style.top = a.cTop + "px"; cur.style.height = Math.max(20, a.cBot - a.cTop) + "px";
  }

  /* ================= LIVE: every note goes green or red as it is played =================
     Anthony, 2026-09-27: "I'd like feedback on whether the play is clean or dirty to be live. Like when
     someone does a rep of something ... the notes being red when dirty and green when clean." And, on
     headphones: "I don't want people to have to have headphones to use it" - hence the beep + notch.

     The exercise LOOPS until Stop; every pass is a rep. A note is judged as soon as its listening window
     has closed (~50 ms after it), on the last ~0.5 s of audio, by the same listen() the offline bench
     holds to its bar. Green = within the strictness; red = outside it, marked early or late; red "miss"
     = nothing there; grey "?" = not heard, but the window was too loud to be sure (a soft tap buried in
     the ring before it) - a guess is never shown as red. A rep is CLEAN when every note in it is green and
     nothing extra was played; the page counts clean reps in a row.

     Not calibrated -> SELF-TIMED, live: the grid locks onto the player's own hits once enough of them agree
     (the first beat or two show "locking on"), then holds. */
  var L = null;
  function strictMs() { return +$("strict").value || 10; }
  function verdict(v) {
    if (!v) return null;
    if (!v.found) return v.busy ? { cls: "unsure", txt: "?" } : { cls: "missed", txt: "miss" };
    var e = Math.abs(v.errMs) < 0.05 ? 0 : v.errMs;
    if (Math.abs(e) <= strictMs()) return { cls: "on", txt: (e >= 0 ? "+" : "") + e.toFixed(1) };
    return e < 0 ? { cls: "early", txt: "\u25C2" + Math.abs(e).toFixed(0) } : { cls: "late", txt: Math.abs(e).toFixed(0) + "\u25B8" };
  }
  function paintNote(i, v) {
    var inner = $("sheetInner"), a = L && L.built.anchors[i], vd = verdict(v);
    if (!inner || !a || !vd) return;
    document.querySelectorAll('#sheetInner [data-n="' + i + '"]').forEach(function (el) { el.remove(); });
    var mk = document.createElement("div"); mk.className = "mark " + vd.cls; mk.setAttribute("data-n", i);
    mk.style.left = a.x + "px"; mk.style.top = a.cTop + "px"; mk.style.height = Math.max(20, a.cBot - a.cTop) + "px"; inner.appendChild(mk);
    var lb = document.createElement("div"); lb.className = "mlabel " + vd.cls; lb.textContent = vd.txt; lb.setAttribute("data-n", i);
    lb.style.left = a.x + "px"; lb.style.top = (a.cBot + 2) + "px"; inner.appendChild(lb);
  }
  function repaintAll() {
    if (!L) return; $("strictVal").textContent = strictMs() + " ms";
    L.last.forEach(function (v, i) { if (v) paintNote(i, v); });
    L.reps.forEach(scoreRep); showReps();
  }
  function scoreRep(rp) {
    var on = 0;
    rp.notes.forEach(function (v) { var vd = verdict(v); if (vd && vd.cls === "on") on++; });
    rp.on = on; rp.clean = on === rp.notes.length && !rp.extras;
  }
  function showReps() {
    var done = L.reps.filter(function (r) { return r.done; }), streak = 0, best = 0, run = 0;
    done.forEach(function (r) { run = r.clean ? run + 1 : 0; best = Math.max(best, run); });
    streak = run;
    $("score").textContent = done.length ? streak + " clean in a row" : "-";
    $("scoreMsg").innerHTML = (done.length ? "Rep " + done.length + " done · best streak " + best + " · strictness " + strictMs() + " ms" : "Play the notes on the sheet. Each pass is a rep.") +
      (L.lockMsg ? "<br>" + L.lockMsg : "") +
      (L.along ? "<br>Timed against the phone's own notes, as its mic hears them." : L.selfTimed ? '<br><b>Self-timed:</b> judged against your own steadiness, not the click.' : L.off != null ? "<br>Timed against the click (calibrated)." : "");
    $("barsOut").innerHTML = done.slice(-12).map(function (r, k) {
      var n = done.length - Math.min(12, done.length) + k + 1;
      return '<div class="note ' + (r.clean ? "on" : "late") + '">Rep ' + n + "<small>" + r.on + "/" + r.notes.length + (r.extras ? " +" + r.extras + " extra" : "") + "</small></div>";
    }).join("");
    $("s-res").hidden = false;
  }

  // the recording, kept as the worklet's blocks; any span of context frames can be copied out of it
  function segment(f0, f1) {
    var out = new Float32Array(Math.max(0, Math.round(f1 - f0)));
    for (var c = L.chunks.length - 1; c >= 0; c--) {
      var ch = L.chunks[c], cs = ch.frame, ce = cs + ch.data.length;
      if (ce <= f0) break;
      if (cs >= f1) continue;
      var a = Math.max(cs, f0), b = Math.min(ce, f1);
      out.set(ch.data.subarray(a - cs, b - cs), a - f0);
    }
    return out;
  }
  // context frame where note i of rep r is SCHEDULED (the device delay is added on top)
  function schedFrame(r, i) { return (L.P + (r * L.repBeats + L.built.times[i]) * L.beat) * L.sr; }
  function noteAt(k) { var n = L.built.times.length; return { r: Math.floor(k / n), i: k % n }; }
  function winOf(k) {
    var n = L.built.times.length, me = noteAt(k), t = schedFrame(me.r, me.i), gap = Infinity;
    if (k > 0) { var p = noteAt(k - 1); gap = Math.min(gap, t - schedFrame(p.r, p.i)); }
    var q = noteAt(k + 1); gap = Math.min(gap, schedFrame(q.r, q.i) - t);
    return Math.min(0.045 * L.sr, gap * 0.45);
  }

  function startLive() {
    drawSheet(); clearMarks();
    var ctx = S.ctx, sr = ctx.sampleRate, bpm = +$("bpm").value || 90, beat = 60 / bpm, built = SHEET;
    var t0 = ctx.currentTime + 0.5;
    L = { built: built, sr: sr, bpm: bpm, beat: beat, P: t0 + 4 * beat, repBeats: built.bars * 4,
          clickAll: document.querySelector('input[name="click"]:checked').value === "all" && !onSpeaker(),
          along: document.querySelector('input[name="click"]:checked').value === "along",
          off: S.offset, selfTimed: S.offset == null, lockMsg: S.offset == null ? "Locking on to your beat..." : "",
          chunks: [], lastFrame: 0, next: 0, schedUntil: t0, reps: [], last: [], extrasSeen: [], hits: [], running: true, truth: {} };
    if (L.along) {   // no calibration: the pass where the phone plays alone is the calibration (alongTick)
      L.off = 0; L.selfTimed = false; L.lockMsg = "Listening to the phone. Stay quiet the first time through.";
      L.own = null; L.learnRep = 0; L.onsets = []; L.heardPk = []; L.margins = [];
      L.accs = S.pads.filter(function (p) { return !p.tap; }); L.taps = S.pads.filter(function (p) { return p.tap; });
    }
    // count-in: 4 beeps, the first one louder
    for (var k = 0; k < 4; k++) play(beep(), t0 + k * beat, (k === 0 ? 1 : 0.6) * (L.along ? ALONG_VOL : 1));
    var port = S.node.port;
    port.onmessage = function (e) {
      if (e.data.stopped) { port.onmessage = null; return; }
      L.chunks.push(e.data); L.lastFrame = e.data.frame + e.data.data.length;
      var keep = 300 * sr, total = 0;                       // keep the last 5 minutes for the download
      for (var c = L.chunks.length - 1; c >= 0; c--) { total += L.chunks[c].data.length; if (total > keep) { L.chunks.splice(0, c); break; } }
    };
    port.postMessage("start");
    $("playBtn").textContent = "Stop"; $("playBtn").className = "purple"; $("hearBtn").disabled = true;
    $("playMsg").textContent = L.along ? "Count-in, then LISTEN once through (stay quiet). Play from the second time through. Press Stop when done."
      : "Count-in: 4 beeps, then play the sheet over and over. Press Stop when done.";
    L.timer = setInterval(liveTick, 50);
    var run = ++cursorRun;
    (function tick() {
      if (run !== cursorRun || !L || !L.running) { cursorEl().style.display = "none"; return; }
      var pos = (S.ctx.currentTime - (S.ctx.outputLatency || 0) - L.P) / L.beat;
      placeCursor(L.built, pos >= 0 ? pos % L.repBeats : -1);
      requestAnimationFrame(tick);
    })();
    showReps();
  }

  function stopLive() {
    if (!L) return;
    L.running = false; clearInterval(L.timer); ++cursorRun; cursorEl().style.display = "none";
    S.node.port.postMessage("stop");
    $("playBtn").textContent = "Start"; $("playBtn").className = "orange"; $("hearBtn").disabled = false; $("playMsg").textContent = "";
    // a download of the whole session (last 5 minutes), with every note that was judged
    var f0 = L.chunks.length ? L.chunks[0].frame : 0, x = segment(f0, L.lastFrame), sched = [];
    for (var k = 0; k < L.next; k++) { var nk = noteAt(k); sched.push(schedFrame(nk.r, nk.i) / L.sr); }
    S.take = { kind: L.along ? "along" : "live", along: L.along ? { own: L.own, learnRep: L.learnRep, vol: ALONG_VOL } : undefined,
               r: { x: x, frame0: f0, gaps: 0 }, sr: L.sr, sched: sched, offset: L.off, bpm: L.bpm, bars: L.built.bars, exercise: L.built.ex.id,
               plan: L.reps.map(function (r) { return { on: r.on, clean: r.clean, extras: r.extras }; }) };
  }

  function liveTick() {
    if (!L || !L.running) return;
    var sr = L.sr, now = S.ctx.currentTime, n = L.built.times.length;
    // 1. schedule the beeps a little ahead (and the test drummer, if asked for)
    while (L.schedUntil < now + 0.35) {
      var b = Math.round((L.schedUntil - L.P) / L.beat);
      var bt = L.P + b * L.beat;
      if (bt >= L.schedUntil - 1e-6 && bt >= L.P) {
        if (L.clickAll) play(beep(), bt, (b % 4) === 0 ? 0.9 : 0.5);
        if (L.along) { play(beep(), bt, ((b % 4) === 0 ? 0.9 : 0.5) * ALONG_VOL); alongNotes(b); }
      }
      L.schedUntil = L.P + (b + 1) * L.beat;
      if (TEST_DRUMMER != null) testDrummer(b);
    }
    var cur = L.lastFrame;
    if (!cur) return;
    if (L.along) { alongTick(cur); return; }
    // 2. self-timed: lock the grid onto the player's own hits
    if (L.off == null) { lockOn(cur); if (L.off == null) return; }
    // 3. judge every note whose window has closed
    var ready = [];
    while (true) {
      var nk = noteAt(L.next), e = schedFrame(nk.r, nk.i) + L.off;
      if (e + winOf(L.next) + 0.03 * sr > cur) break;
      ready.push(L.next); L.next++;
    }
    if (!ready.length) return;
    var first = noteAt(ready[0]), s0 = Math.max(L.chunks[0].frame, schedFrame(first.r, first.i) + L.off - 0.45 * sr);
    var seg = segment(s0, cur), exp = [], idx = [];
    for (var k = Math.max(0, ready[0] - 2 * n); k < L.next + 2 * n; k++) {
      var q = noteAt(k), f = schedFrame(q.r, q.i) + L.off;
      if (f < s0 + 0.02 * sr || f > cur + 0.2 * sr) continue;
      exp.push({ t: (f - s0) / sr }); idx.push(k);
    }
    var res = RDMOnsets.listen(seg, sr, exp, { notch: NOTCH });
    idx.forEach(function (k, j) {
      if (ready.indexOf(k) < 0) return;
      var v = res.notes[j], q = noteAt(k);
      if (!L.reps[q.r]) L.reps[q.r] = { notes: new Array(n), extras: 0, done: false };
      L.reps[q.r].notes[q.i] = v; L.last[q.i] = v; paintNote(q.i, v);
      if (TEST_DRUMMER != null) window.__tlSeen[q.r + ":" + q.i] = v.found ? v.errMs : null;
      if (q.i === n - 1) { L.reps[q.r].done = true; scoreRep(L.reps[q.r]); showReps(); }
    });
    // extras: heard, claimed by no note, settled, and not already counted
    res.extras.forEach(function (x) {
      var fa = s0 + x.sample;
      if (fa > cur - 0.1 * sr || fa < s0 + 0.25 * sr || fa < schedFrame(0, 0) + L.off - 0.05 * sr) return;
      if (L.extrasSeen.some(function (g) { return Math.abs(g - fa) < 0.01 * sr; })) return;
      L.extrasSeen.push(fa);
      var r = Math.max(0, Math.floor(((fa - L.off) / sr - L.P) / (L.repBeats * L.beat)));
      if (!L.reps[r]) L.reps[r] = { notes: new Array(n), extras: 0, done: false };
      L.reps[r].extras++;
      if (L.reps[r].done) { scoreRep(L.reps[r]); showReps(); }
    });
  }

  /* ================= PLAY ALONG: the phone plays the click AND the notes, on its speaker, and still knows which hits are yours ======
     Anthony, 2026-11-11: "students will be playing with a click, or with the actual audio. They will be PLAYING ALONG cuz its a
     playalong tool, they just need help knowing if theyre right or wrong." And, when taking the phone's sound out of the recording
     had failed on his phone (1 to 11 dB): "its not about subtracting ... you should know how the computer real audio sounds, then
     compare it to the persons added audio, the difference tells you clean or not?"

     That is this mode, and it is what his takes showed works (dev/echo-loud.js, MAC-SYNC 710):
       1. THE FIRST TIME THROUGH NOBODY PLAYS. The page hears its own notes through its own mic and keeps, for each note of the
          exercise, how loud it is there and exactly where it sits. That pass is the calibration; nothing else is needed.
       2. FROM THE SECOND TIME THROUGH, a hit that is 10 dB or more over the phone's own note at that place is the player's, and
          its time is read against where the phone's note sits. Anything nearer the phone's own level is the phone.
       3. IT NEVER GUESSES. A note with no such hit is "?" (grey) while the player cannot be told from the phone, and "miss" (red)
          only once the player has been heard well over the phone. If most of a pass cannot be read it says so: turn the volume
          down, or move the phone closer.
     Measured on his S22 with a pad: at full volume the phone was as loud as him at its own mic and 0 of 40 notes could be read;
     at half volume he sat 11 to 16 dB over it and 40 of 40 were, with 0 of 24 read in the bars he sat out. The click's 2 kHz beep
     is filtered out first (NOTCH), which works once the speaker is not being driven flat out. */
  var ALONG_VOL = (function () { var m = /[?&]alongvol=([\d.]+)/.exec(location.search); return m ? +m[1] : 1; })();   // TEST: the phone's own playing, scaled
  var OVER_DB = 10, SURE_DB = 16, TOO_LOUD_DBFS = -3;
  function alongNotes(b) {   // the exercise itself, on pad sounds, exactly on the grid
    var rep = Math.floor(b / L.repBeats), inRep = b - rep * L.repBeats;
    L.built.times.forEach(function (t, i) {
      if (t < inRep || t >= inRep + 1) return;
      var acc = L.built.accents[i], pool = acc ? L.accs : L.taps, pad = pool[i % pool.length];
      play(pad.buf, L.P + (rep * L.repBeats + t) * L.beat - pad.start, (acc ? 0.9 : 0.35) * ALONG_VOL);
    });
  }
  /* the level around a stretch of the recording (context frames), the click's beep filtered out: 2 ms windows every third of a ms */
  function envAround(f0, f1) {
    var sr = L.sr, lead = Math.round(0.06 * sr), a = Math.max(L.chunks[0].frame, Math.round(f0) - lead), seg = segment(a, Math.round(f1));
    var y = RDMOnsets.highpass(RDMOnsets.notchAll(seg, sr, NOTCH), sr, 40), hop = Math.max(1, Math.round(sr / 3000)), win = hop * 6;
    var skip = Math.round(f0) - a, nF = Math.max(0, Math.floor((y.length - skip - win) / hop) + 1), E = new Float32Array(nF);
    for (var f = 0; f < nF; f++) { var e = 0, b = skip + f * hop; for (var j = 0; j < win; j++) e += y[b + j] * y[b + j]; E[f] = 10 * Math.log10(e / win + 1e-14); }
    return { E: E, hop: hop, win: win, base: Math.round(f0) };     // E[f] is frames base + f*hop .. + win
  }
  /* from a frame that is over a level, back to where the sound first went over `floorDb` (at most 4 ms back) */
  function crossBack(env, f, floorDb) { var g = f, lim = Math.round(0.004 * L.sr / env.hop); while (g > 0 && f - g < lim && env.E[g - 1] >= floorDb) g--; return g; }
  function median(a) { var s = a.slice().sort(function (x, y) { return x - y; }); return s.length ? s[s.length >> 1] : null; }
  function alongTick(cur) {
    var sr = L.sr, n = L.built.times.length;
    // every hit in the last 0.6 s, once, on the context's own frames; one is kept only once it is 60 ms old (its level is settled)
    var s0 = Math.max(L.chunks[0].frame, cur - 0.6 * sr), seg = segment(s0, cur);
    RDMOnsets.detect(seg, sr, { notch: NOTCH }).forEach(function (h) {
      var fa = s0 + h.sample;
      if (fa > cur - 0.06 * sr || (s0 > L.chunks[0].frame && fa < s0 + 0.08 * sr)) return;
      if (!L.onsets.some(function (g) { return Math.abs(g.f - fa) < 0.004 * sr; })) L.onsets.push({ f: fa, pk: h.peakDb, used: false });
    });
    if (L.onsets.length > 600) L.onsets.splice(0, L.onsets.length - 400);
    if (!L.own) { learnPhone(cur); if (!L.own) return; }
    var done = false;
    while (true) {
      var q = noteAt(L.next), place = schedFrame(q.r, q.i) + L.own.t[q.i], w = winOf(L.next);
      if (place + w + 0.07 * sr > cur) break;
      /* THE LEVEL ITSELF, NOT THE DETECTOR'S LIST OF HITS. A player 1 to 8 ms behind the phone's own note is one hit to the detector
         (it holds for 8 ms after a hit, so a room's first echo is not a second hit), and it gave that hit the PHONE's time: the first
         build read such a note up to 6.4 ms wrong. So: the level around the note, the click filtered out; the player is there from
         the first moment it stands OVER_DB over the phone's own note at this place, and starts where it first left the phone's
         level behind (4 dB over it). The phone's own place was read the same way in the listening pass, so the two times compare. */
      var env = envAround(place - w, place + w + 0.012 * sr), thr = L.own.lv[q.i] + OVER_DB, hitF = -1;
      for (var f = 0; f < env.E.length; f++) if (env.E[f] >= thr) { hitF = f; break; }
      var v, tHit = hitF < 0 ? null : env.base + crossBack(env, hitF, L.own.lv[q.i] + 4) * env.hop + env.win - env.hop;
      if (tHit != null && Math.abs(tHit - place) <= w) {
        var lvl = -200; for (f = hitF; f < env.E.length && (f - hitF) * env.hop < 0.008 * sr; f++) lvl = Math.max(lvl, env.E[f]);
        v = { found: true, errMs: (tHit - place) / sr * 1000, how: "over the phone" };
        L.heardPk.push(lvl); L.margins.push(lvl - L.own.lv[q.i]);
        if (L.heardPk.length > 32) { L.heardPk.shift(); L.margins.shift(); }
        L.onsets.forEach(function (o) { if (Math.abs(o.f - tHit) < 0.008 * sr) o.used = true; });
      } else {
        // a miss only if the player has been heard well over the phone at this place; otherwise it cannot be told, and says so
        var mh = median(L.heardPk);
        v = { found: false, busy: !(mh != null && mh >= L.own.lv[q.i] + SURE_DB), how: "only the phone" };
      }
      if (!L.reps[q.r]) L.reps[q.r] = { notes: new Array(n), extras: 0, done: false };
      L.reps[q.r].notes[q.i] = v; L.last[q.i] = v; paintNote(q.i, v);
      if (TEST_DRUMMER != null) window.__tlSeen[q.r + ":" + q.i] = v.found ? v.errMs : null;
      if (q.i === n - 1) { L.reps[q.r].done = true; done = true; alongAdvice(L.reps[q.r]); }
      L.next++;
    }
    // extras: a hit as loud as the player's own, claimed by no note, and not the phone's own note
    var mh2 = median(L.heardPk), settled = schedFrame(noteAt(L.next).r, noteAt(L.next).i) - 0.2 * sr;
    if (mh2 != null) L.onsets.forEach(function (o) {
      if (o.used || o.f > settled || o.f < schedFrame(L.learnRep + 1, 0) || o.pk < mh2 - 10) return;
      o.used = true;
      var k = Math.max(0, Math.round(((o.f - L.own.dMed) / sr - L.P) / L.beat * (n / L.repBeats))), r = Math.floor(k / n);
      for (var dk = -1; dk <= 1; dk++) { var qq = noteAt(Math.max(0, k + dk)); if (Math.abs(o.f - (schedFrame(qq.r, qq.i) + L.own.d[qq.i])) < 0.006 * sr) return; }   // the phone's own note
      if (!L.reps[r]) L.reps[r] = { notes: new Array(n), extras: 0, done: false };
      L.reps[r].extras++; done = true;
    });
    if (done) { L.reps.forEach(scoreRep); showReps(); }
  }
  /* the pass where the phone plays alone: the delay that lines the most hits up with the notes (the phone is exact, so 3 ms wide),
     then each note's own place and level. A pass with someone playing in it is not used: the next one is. */
  function learnPhone(cur) {
    var sr = L.sr, n = L.built.times.length, r0 = L.learnRep, a = schedFrame(r0, 0), b = schedFrame(r0 + 1, 0);
    if (cur < b + 0.75 * sr) return;
    var hits = L.onsets.filter(function (o) { return o.f >= a && o.f < b + 0.7 * sr; }), ds = [];
    for (var i = 0; i < n; i++) hits.forEach(function (o) { var d = o.f - schedFrame(r0, i); if (d > 0 && d < 0.7 * sr) ds.push({ i: i, d: d }); });
    ds.sort(function (x, y) { return x.d - y.d; });
    var best = null, W = 0.003 * sr;
    for (var p = 0; p < ds.length; p++) {
      var seen = {}, m = 0;
      for (var q = p; q < ds.length && ds[q].d - ds[p].d <= W; q++) if (!seen[ds[q].i]) { seen[ds[q].i] = 1; m++; }
      if (!best || m > best.n) best = { n: m, d: ds[p].d + W / 2 };
    }
    if (!best || best.n < Math.max(3, Math.ceil(n * 0.5))) { L.learnRep++; L.next = (L.learnRep + 1) * n; L.lockMsg = "I could not hear the phone's own notes. Turn the volume up a little. Listening again..."; showReps(); return; }
    var d = [], pk = [];
    for (i = 0; i < n; i++) {
      var want = schedFrame(r0, i) + best.d, near = null;
      hits.forEach(function (o) { if (Math.abs(o.f - want) <= 0.004 * sr && (!near || o.pk > near.pk)) near = o; });
      d.push(near ? near.f - schedFrame(r0, i) : best.d); pk.push(near ? near.pk : -200);
    }
    var heard = pk.filter(function (v) { return v > -199; }), floor = median(heard);
    // someone playing in the listening pass: hits as loud as the phone's own that sit on none of its notes
    var stray = hits.filter(function (o) {
      if (o.f >= b + best.d - 0.004 * sr) return false;
      for (var j = 0; j < n; j++) if (Math.abs(o.f - (schedFrame(r0, j) + d[j])) <= 0.004 * sr) return false;
      return o.pk >= floor - 3;
    }).length;
    if (stray > 1) { L.learnRep++; L.next = (L.learnRep + 1) * n; L.lockMsg = "I heard playing. Stay quiet for one time through."; showReps(); return; }
    /* THE PHONE TOO LOUD FOR ITS OWN MIC (Anthony's take, 2026-11-12). The phone alone peaked at -0.5 dBFS: his hits clipped the
       mic, stood only 5 to 13 dB over the phone, and a third of them could be read. The half-volume take that read 40 of 40 had the
       phone alone at about -6 dBFS. So a phone over -3 dBFS in the quiet pass leaves no room above it for the player: say so now,
       before anyone plays, and listen again (turning it down changes how loud its notes are, so they are learned again). */
    var raw = segment(a, b + best.d + 0.05 * sr), peak = 0;
    for (i = 0; i < raw.length; i++) { var s = raw[i] < 0 ? -raw[i] : raw[i]; if (s > peak) peak = s; }
    var peakDb = 20 * Math.log10(peak + 1e-9);
    if (LOOP != null) window.__tlPhonePeak = +peakDb.toFixed(1);
    if (peakDb > TOO_LOUD_DBFS) { L.learnRep++; L.next = (L.learnRep + 1) * n; L.lockMsg = "<b>Too loud.</b> The phone is filling its own mic, so I can't hear you over it. Turn the volume down 2 steps and stay quiet one more time through."; showReps(); return; }
    /* each of its own notes, read off the level: how loud it gets (lv) and where it starts (t: the first moment it is within 10 dB
       of that, the same kind of mark the player's start is read from). A note the detector never listed is still measured here. */
    var lv = [], t = [];
    for (i = 0; i < n; i++) {
      var p0 = schedFrame(r0, i) + d[i], env = envAround(p0 - 0.006 * sr, p0 + 0.014 * sr), mx = -200, at = 0;
      for (var f = 0; f < env.E.length; f++) if (env.E[f] > mx) { mx = env.E[f]; at = f; }
      lv.push(mx);
      t.push(env.base + crossBack(env, at, mx - 10) * env.hop + env.win - env.hop - schedFrame(r0, i));
    }
    L.own = { d: d, pk: pk, lv: lv, t: t, dMed: best.d, peakDb: +peakDb.toFixed(1) }; L.next = (L.learnRep + 1) * n; L.lockMsg = "Got the phone. Play now."; showReps();
  }
  function alongAdvice(rp) {
    var read = rp.notes.filter(function (v) { return v && v.found; }).length, m = median(L.margins);
    L.lockMsg = read < rp.notes.length / 2 ? "<b>I can't hear you over the phone.</b> Turn the volume down, or move the phone closer to the drum."
      : m != null && m < 14 ? "You are only " + m.toFixed(0) + " dB over the phone. A little less volume would be safer."
      : m != null ? "You are " + m.toFixed(0) + " dB over the phone." : "";
  }

  /* self-timed lock: the player's hits against the notes scheduled so far. The delay that lines up the
     most of them (clustered within 40 ms - a person spreads 10-20 ms) is found, then placed at the median
     of the matched notes. Holds once 8 notes agree, so a verdict never changes under the player. */
  function lockOn(cur) {
    var sr = L.sr, s0 = Math.max(L.chunks[0].frame, cur - 2 * sr), seg = segment(s0, cur);
    RDMOnsets.detect(seg, sr, { notch: NOTCH }).forEach(function (h) {
      var fa = s0 + h.sample;
      if (fa < cur - 0.05 * sr && !L.hits.some(function (g) { return Math.abs(g - fa) < 0.005 * sr; })) L.hits.push(fa);
    });
    var sched = [], n = L.built.times.length;
    for (var k = 0; ; k++) { var q = noteAt(k), f = schedFrame(q.r, q.i); if (f > cur) break; sched.push(f); }
    if (sched.length < 4 || L.hits.length < 4) return;
    var ds = [];
    sched.forEach(function (si, i) { L.hits.forEach(function (h) { var d = h - si; if (d > -0.05 * sr && d < 0.8 * sr) ds.push({ i: i, d: d }); }); });
    ds.sort(function (a, b) { return a.d - b.d; });
    var best = null, W = 0.04 * sr;
    for (var a = 0; a < ds.length; a++) {
      var seen = {}, m = 0;
      for (var b = a; b < ds.length && ds[b].d - ds[a].d <= W; b++) if (!seen[ds[b].i]) { seen[ds[b].i] = 1; m++; }
      if (!best || m > best.n) best = { n: m, d: ds[a].d + W / 2 };
    }
    if (!best || best.n < 8) { L.lockMsg = "Locking on to your beat... (" + (best ? best.n : 0) + " of 8 notes)"; showReps(); return; }
    var near = [];
    sched.forEach(function (si) {
      var nb = null;
      L.hits.forEach(function (h) { var d = h - si; if (Math.abs(d - best.d) < 0.06 * sr && (nb == null || Math.abs(d - best.d) < Math.abs(nb - best.d))) nb = d; });
      if (nb != null) near.push(nb);
    });
    near.sort(function (x, y) { return x - y; });
    L.off = near[Math.floor(near.length / 2)]; L.lockMsg = ""; showReps();
  }

  /* ?loopback=..&drummer=8 - TEST ONLY: the page plays the part itself on pad sounds, every note pushed
     early or late by a random amount (sd 8 ms) it records in window.__tlTruth, so a harness can check
     that each live verdict reads back the push. Never on without the loopback switch. */
  function selfTimedNote() {
    if (S.offset == null) $("playMsg").innerHTML = "Not calibrated: this will be <b>self-timed</b> (judged against your own steadiness).";
  }
  function expectedOf(tk) { return tk.sched.map(function (t) { return { t: (t * tk.sr - tk.r.frame0 + tk.offset) / tk.sr }; }); }

  var TEST_DRUMMER = (function () { var m = /[?&]drummer=([\d.]+)/.exec(location.search); return LOOP != null && m ? +m[1] : null; })();
  window.__tlTruth = {}; window.__tlSeen = {};
  function testDrummer(b) {
    if (!S.pads || b < 0) return;
    var n = L.built.times.length, rep = Math.floor(b / L.repBeats), inRep = b - rep * L.repBeats;
    if (L.along && rep === 0) return;                       // the pass where the phone plays alone
    L.built.times.forEach(function (t, i) {
      if (t < inRep || t >= inRep + 1) return;
      var g = 0; for (var z = 0; z < 6; z++) g += Math.random(); g = (g - 3) * Math.sqrt(2);   // ~N(0,1)
      var dMs = Math.round(g * TEST_DRUMMER * 10) / 10, pad = S.pads[(rep * n + i) % S.pads.length];
      /* playing along, the test player plays the PART: an accent where one is written, a tap where one is. (A tap played where the phone
         plays an accent is only 4 dB over it, and is rightly left unread: 2 of 42 in the first run of dev/along-test.cjs.) */
      if (L.along) { var pool = L.built.accents[i] ? L.accs : L.taps; pad = pool[(rep * n + i) % pool.length]; }
      window.__tlTruth[rep + ":" + i] = dMs;
      play(pad.buf, L.P + (rep * L.repBeats + t) * L.beat + dMs / 1000 - pad.start, pad.tap ? 0.3 : 0.9);
    });
  }

  /* ---------- robot drummer ---------- */
  async function robot() {
    $("robotBtn").disabled = true; $("robotMsg").textContent = "Loading pad sounds..."; $("robotLog").textContent = "";
    var P0 = await pads(), ctx = S.ctx, sr = ctx.sampleRate, N = 48, step = 0.3, P = ctx.currentTime + 0.6, plan = [];
    for (var i = 0; i < N; i++) {
      var pad = P0[Math.floor(Math.random() * P0.length)];
      var dMs = Math.round((Math.random() * 50 - 25) * 10) / 10;               // -25..+25 ms, known only here
      plan.push({ pad: pad, dMs: dMs, nominal: P + i * step, gain: pad.tap ? 0.2 : 0.9 });   // taps 14 dB under accents
    }
    $("robotMsg").textContent = "Playing 48 hits... stay quiet.";
    var rec = record(P + N * step - ctx.currentTime + 0.8);
    plan.forEach(function (p) { play(p.pad.buf, p.nominal + p.dMs / 1000 - p.pad.start, p.gain); });
    var r = await rec;
    var tk = { r: r, sr: sr, sched: plan.map(function (p) { return p.nominal; }), offset: S.offset };
    var res = RDMOnsets.listen(r.x, sr, expectedOf(tk));
    var devs = [], unheard = 0, lines = [];
    res.notes.forEach(function (v, i) {
      if (!v.found) { unheard++; lines.push("hit " + (i + 1) + ": played " + plan[i].dMs + " ms, NOT HEARD"); return; }
      var dev = v.errMs - plan[i].dMs; devs.push(dev);
      lines.push("hit " + (i + 1) + ": played " + (plan[i].dMs >= 0 ? "+" : "") + plan[i].dMs.toFixed(1) + " ms, measured " + (v.errMs >= 0 ? "+" : "") + v.errMs.toFixed(1) + " ms  (off by " + dev.toFixed(2) + ")");
    });
    var abs = devs.map(Math.abs).sort(function (a, b) { return a - b; });
    var mean = devs.reduce(function (a, b) { return a + b; }, 0) / (devs.length || 1), max = abs[abs.length - 1] || 0;
    var ok = !unheard && !res.extras.length && max <= 1;
    $("robotMsg").innerHTML = (ok ? '<span class="ok">PASS.</span> ' : '<span class="bad">NOT YET.</span> ') +
      "Heard " + (N - unheard) + " of " + N + ", " + res.extras.length + " extra. Measured vs true: worst <b>" + max.toFixed(2) + " ms</b>, average " + mean.toFixed(2) + " ms." + (r.gaps ? " " + r.gaps + " audio dropouts." : "");
    $("robotLog").textContent = lines.join("\n");
    S.take = { kind: "robot", r: r, sr: sr, sched: tk.sched, offset: S.offset, plan: plan.map(function (p) { return { dMs: p.dMs, gain: p.gain }; }) };
    $("robotBtn").disabled = false;
  }

  /* ---------- download a take (for the lab bench) ---------- */
  function wav(x, sr) {
    var b = new DataView(new ArrayBuffer(44 + x.length * 2)), w = function (o, s) { for (var i = 0; i < s.length; i++) b.setUint8(o + i, s.charCodeAt(i)); };
    w(0, "RIFF"); b.setUint32(4, 36 + x.length * 2, true); w(8, "WAVEfmt "); b.setUint32(16, 16, true); b.setUint16(20, 1, true); b.setUint16(22, 1, true);
    b.setUint32(24, sr, true); b.setUint32(28, sr * 2, true); b.setUint16(32, 2, true); b.setUint16(34, 16, true); w(36, "data"); b.setUint32(40, x.length * 2, true);
    for (var i = 0; i < x.length; i++) b.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767))), true);
    return new Blob([b], { type: "audio/wav" });
  }
  function save(blob, name) { var a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); }
  function download() {
    var tk = S.take; if (!tk) return;
    var stamp = new Date().toISOString().replace(/[:.]/g, "-"), meta = {
      kind: tk.kind, sampleRate: tk.sr, deviceDelayFrames: tk.offset, accMs: S.accMs, output: S.calOut,
      expectedSeconds: expectedOf(tk).map(function (e) { return e.t; }), bpm: tk.bpm, exercise: tk.exercise, bars: tk.bars, plan: tk.plan, gaps: tk.r.gaps, along: tk.along,
      device: $("devInfo").textContent
    };
    save(wav(tk.r.x, tk.sr), "timing-" + tk.kind + "-" + stamp + ".wav");
    setTimeout(function () { save(new Blob([JSON.stringify(meta, null, 1)], { type: "application/json" }), "timing-" + tk.kind + "-" + stamp + ".json"); }, 400);
  }

  /* ---------- wiring ---------- */
  $("micBtn").onclick = function () { openMic().catch(function (e) { $("micMsg").innerHTML = '<span class="bad">No microphone: ' + e.message + "</span>"; }); };
  $("micSel").onchange = function () { openMic(this.value); };
  $("calBtn").onclick = calibrate;
  $("playBtn").onclick = function () {
    if (L && L.running) return stopLive();
    if (TEST_DRUMMER != null || document.querySelector('input[name="click"]:checked').value === "along") pads().then(startLive); else startLive();
  };
  $("hearBtn").onclick = hear;
  EXERCISES.forEach(function (x) { var o = document.createElement("option"); o.value = x.id; o.textContent = x.name; $("ex").appendChild(o); });
  $("ex").value = "e";
  $("ex").onchange = function () { drawSheet(); clearMarks(); };
  $("bars").onchange = function () { drawSheet(); clearMarks(); };
  window.addEventListener("resize", function () { if (!S.take) drawSheet(); });
  drawSheet();
  $("robotBtn").onclick = robot;
  /* NO CLICK WHILE YOU PLAY ON A SPEAKER (a real phone, 2026-11-11, Anthony's S22: "downloaded, its off"). With the click on the
     whole time through the phone's own speaker, the click reached the mic 7 dB LOUDER than his pad, the 2 kHz filter did not take it
     out (a phone speaker is not a clean 2 kHz), and the page scored its own click as his notes: 68 of 68 notes on the beat "heard",
     19 of them at exactly +6 ms, including the reps where he had stopped playing them. A wrong verdict is the one thing this tool
     must never give, so on a speaker the click is the count-in only. Headphones keep the click out of the mic and may have it. */
  function onSpeaker() { return document.querySelector('input[name="out"]:checked').value === "speaker"; }
  function syncClick() {
    var all = document.querySelector('input[name="click"][value="all"]'), sp = onSpeaker();
    all.disabled = sp;
    if (sp && all.checked) document.querySelector('input[name="click"][value="countin"]').checked = true;
    $("clickNote").textContent = sp ? "On a speaker the click is the count-in only: the phone would hear its own click and score it as your notes. Headphones can have the click the whole time." : "";
  }
  document.querySelectorAll('input[name="out"]').forEach(function (r) { r.addEventListener("change", syncClick); });
  syncClick();
  $("strict").oninput = repaintAll;
  $("dlBtn").onclick = download;
  document.querySelectorAll('input[name="out"]').forEach(function (r) {
    r.onchange = function () {
      $("calHow").textContent = this.value === "speaker"
        ? "Turn the volume up. The page plays clicks and listens for them to measure this device's delay. Stay quiet for 6 seconds."
        : this.value === "headphones"
          ? "Hold one earcup right against the mic, volume up. The page measures the delay through your headphones. Stay quiet for 6 seconds."
          : "Hold one earbud right against the mic, volume up. Bluetooth adds its own delay; this measures it, and how steady it is. Stay quiet for 6 seconds.";
      S.offset = null; $("robotBtn").disabled = true; $("calMsg").textContent = "Calibrate again for this output."; selfTimedNote();
    };
  });
  if (!window.isSecureContext || !navigator.mediaDevices) $("micMsg").innerHTML = '<span class="bad">The mic needs a secure (https) page.</span>';
})();
