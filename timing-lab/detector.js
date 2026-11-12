/* RDMOnsets - finds every stick hit in a recording and the exact sample it STARTS on.
 *
 * Two stages, because "is there a hit here" and "exactly when did it start" are different questions and
 * each is answered best by a different tool:
 *
 *   1. FIND  - an energy envelope on a ~0.67 ms hop. A hit is a sudden RISE: the level now against the
 *              quietest it was over the last few ms. Rise, not level, is what lets a soft tap be found on
 *              the decaying tail of a loud accent right before it; a level threshold would either miss the
 *              tap or fire on the tail.
 *   2. PLACE - an AIC change-point picker (the one seismologists use for first arrivals) on the raw,
 *              high-passed samples between the quiet before the hit and its peak. It finds the single
 *              sample where the signal stops looking like what came before, whatever the hit's loudness,
 *              which is the definition in README.md: a hit's time is when it STARTS, so an accent and a
 *              tap played together get the same time.
 *
 * Streaming-shaped on purpose (a running noise floor, no whole-file statistics), so the same code can run
 * live in an AudioWorklet in phase 2 with nothing re-derived.
 *
 * UMD: require() in Node for the bench, a plain <script> or importScripts() in the browser. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.RDMOnsets = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var DEFAULTS = {
    hpHz: 40,          // high-pass: rumble, handling noise and DC out; a chest thud still lives above it
    hopMs: 0.667,      // envelope hop (32 samples at 48 kHz)
    winHops: 3,        // envelope window, in hops (2 ms: shorter and plain noise swings by 7 dB frame to frame)
    riseLookMs: 4,     // "the quietest it was" looks back this far
    riseDb: 7,         // a hit must rise at least this much above that
    floorDb: 12,       // ...and sit at least this far above the running noise floor
    holdMs: 8,         // no second hit within this long after the last one's trigger
    peakMs: 8,         // the hit's peak is searched this far after the trigger
    preMs: 12,         // the AIC window starts this far before the trigger (or just after the last hit)
    floorAlpha: 0.002, // the noise floor follows a LOW PERCENTILE of the level, not its minimum (see below)
    /* PRECEDENCE (2026-09-27): a room's first reflections - floor, desk, near wall - land 2-12 ms after a
       hit at -6 to -14 dB, and in the room conditions they passed as hits of their own. The ear fuses any
       arrival within ~30 ms into the first one (the precedence effect), so this does too: inside this
       window after a hit, a new one counts only if it is LOUDER than that hit. A flam still works - its
       grace note comes first and quieter, so the main note is the louder arrival. */
    precMs: 20, precDb: 3  // "louder" means clearly louder: a snare's body and wires bloom ~1 dB past the
                           // stick contact ~5 ms in and re-fired as a second hit at 0 dB (bench 2026-09-27);
                           // 6 dB lost real snare flams whose grace was close to the main note, so 3
  };

  function highpass(x, sr, fc) {
    // RBJ biquad, Q = 0.7071
    var w = 2 * Math.PI * fc / sr, c = Math.cos(w), s = Math.sin(w), al = s / (2 * Math.SQRT1_2);
    var b0 = (1 + c) / 2, b1 = -(1 + c), b2 = (1 + c) / 2, a0 = 1 + al, a1 = -2 * c, a2 = 1 - al;
    b0 /= a0; b1 /= a0; b2 /= a0; a1 /= a0; a2 /= a0;
    var y = new Float32Array(x.length), x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (var i = 0; i < x.length; i++) {
      var v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
    }
    return y;
  }

  // AIC change point of y[a..b): the k that best splits it into "before" and "after" by variance
  function aicPick(y, a, b) {
    var n = b - a;
    if (n < 8) return a;
    var cum = new Float64Array(n + 1);
    for (var i = 0; i < n; i++) cum[i + 1] = cum[i] + y[a + i] * y[a + i];
    var best = Infinity, bk = 1, eps = 1e-20;
    for (var k = 2; k < n - 2; k++) {
      var v1 = cum[k] / k + eps, v2 = (cum[n] - cum[k]) / (n - k) + eps;
      var aic = k * Math.log(v1) + (n - k - 1) * Math.log(v2);
      if (aic < best) { best = aic; bk = k; }
    }
    return a + bk;
  }

  /* detect(samples, sampleRate, opts) -> [{ sample, t, peakDb, riseDb }]
     `sample` is the index the hit starts on; `t` is the same in seconds. */
  /* THE METRONOME BEEP IS FILTERED OUT BEFORE LISTENING (Anthony, 2026-09-27: "I don't want people to have
     to have headphones to use it"). Through a speaker the mic hears the click, and a click landing on the
     beat looks exactly like a perfect hit. So during play the click is a short BEEP at one exact pitch, and
     every listen first notches out that pitch and its first overtones. A stick hit spreads its sound over
     every pitch, so it loses a sliver and is still there; the beep has nothing left. opts.notch: [Hz, ...] */
  function notchAll(x, sr, freqs, q) {
    var y = x;
    (freqs || []).forEach(function (f0) {
      if (!(f0 > 0 && f0 < sr * 0.45)) return;
      /* Q 3, not 6 (2026-09-27): a LOUD beep sitting right on a hit got past a Q 6 notch and pulled the
         hit early by up to 13 ms; Q 3 held it to 0.25 ms. Wider still (Q 2, more passes) starts losing
         real soft taps, so 3 is the measured middle. */
      var w = 2 * Math.PI * f0 / sr, c = Math.cos(w), al = Math.sin(w) / (2 * (q || 3));
      var a0 = 1 + al, b0 = 1 / a0, b1 = -2 * c / a0, b2 = 1 / a0, a1 = -2 * c / a0, a2 = (1 - al) / a0;
      for (var pass = 0; pass < 2; pass++) {                  // twice: ~2x the depth for the same width
        var z = new Float32Array(y.length), x1 = 0, x2 = 0, y1 = 0, y2 = 0;
        for (var i = 0; i < y.length; i++) { var v = b0 * y[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = y[i]; y2 = y1; y1 = v; z[i] = v; }
        y = z;
      }
    });
    return y;
  }

  function detect(x, sr, opts) {
    var o = {}, k;
    for (k in DEFAULTS) o[k] = DEFAULTS[k];
    for (k in (opts || {})) o[k] = opts[k];
    if (o.notch) x = notchAll(x, sr, o.notch);

    var y = highpass(x, sr, o.hpHz);
    var hop = Math.max(1, Math.round(sr * o.hopMs / 1000)), win = hop * o.winHops;
    var nF = Math.floor((y.length - win) / hop) + 1;
    if (nF < 4) return [];
    var E = new Float32Array(nF);
    for (var f = 0; f < nF; f++) {
      var s = 0, base = f * hop;
      for (var j = 0; j < win; j++) { var v = y[base + j]; s += v * v; }
      E[f] = 10 * Math.log10(s / win + 1e-14);
    }

    var look = Math.max(1, Math.round(o.riseLookMs / o.hopMs));
    var hold = Math.round(o.holdMs / o.hopMs), peakF = Math.round(o.peakMs / o.hopMs);
    /* THE NOISE FLOOR IS A ~10th PERCENTILE, NOT THE MINIMUM. The minimum of noisy frames sits well below
       the noise's real level, so "12 dB above the floor" was only a few dB above the actual noise and plain
       noise swings passed as hits (bench 2026-09-27). A quantile tracker: step down 9x faster than up, so
       it settles where ~10% of frames are below it. Hits never drag it up, because they are rare. */
    var fStep = 0.25, fUp = fStep / 9;
    var floor = E[0], lastTrig = -1e9, lastOnset = -1e9, out = [];

    for (f = 1; f < nF; f++) {
      if (E[f] < floor) floor -= fStep; else floor += fUp;
      if (f < 200 && E[f] < floor) floor = E[f];          // the first ~130 ms: settle fast
      if (f - lastTrig < hold) continue;
      /* RISE OVER THE LOUDEST RECENT FRAME, not the quietest. A drum's ringing beats as it decays - its
         level dips and swells by several dB every few ms - so "above the quietest point" fired on every
         swell (hundreds of false hits on a clean recording, bench 2026-09-27). A real new hit climbs
         above everything the tail was doing; a swell only climbs back to where the tail already was.
         The 2 frames just before are left out so a hit's own first frames of attack cannot mask it. */
      var hi = -Infinity;
      for (var q = Math.max(0, f - look); q < f - 2; q++) if (E[q] > hi) hi = E[q];
      if (hi === -Infinity) continue;
      var rise = E[f] - hi;
      if (rise < o.riseDb || E[f] < floor + o.floorDb) continue;

      // the hit's peak, to close the AIC window on
      var pk = f;
      for (q = f; q < Math.min(nF, f + peakF); q++) if (E[q] > E[pk]) pk = q;
      var trigS = f * hop;
      var a = Math.max(0, trigS - Math.round(sr * o.preMs / 1000), lastOnset + Math.round(sr * 0.002));
      var bEnd = Math.min(y.length, pk * hop + win);
      // AIC wants the sample peak, not the frame: close the window on the loudest sample in the peak frame
      var pkS = pk * hop, pkV = 0;
      for (q = pk * hop; q < bEnd; q++) if (Math.abs(y[q]) > pkV) { pkV = Math.abs(y[q]); pkS = q; }
      var onset = aicPick(y, a, Math.max(a + 8, pkS + 1));

      if (out.length && (onset - lastOnset) / sr * 1000 < o.precMs && E[pk] < out[out.length - 1].peakDb + o.precDb) {
        lastTrig = f;                    // a reflection of the last hit: hold off again, keep the hit as it was
        continue;
      }
      out.push({ sample: onset, t: onset / sr, peakDb: E[pk], riseDb: rise });
      lastTrig = f; lastOnset = onset;
    }
    return out;
  }

  /* ================= VERSION 2: THREE BANDS =================
     Why (bench + sweep 2026-09-27): one loudness curve cannot tell a soft tap from a swell in a drum's
     ringing, so no threshold got to zero mistakes - loosen it and swells count, tighten it and taps go
     missing. In bands they separate:
       - a stick hit jumps in every band at once, the treble most of all (the click of the stick);
       - ringing beats in one band at a time (the modes that beat are close together in pitch);
       - fan / room noise is mostly low, where a soft tap's click is not.
     So the detection value is the SUM of each band's rise over its own recent loudest, counted only where
     that band is above its own noise floor. Placement (AIC) then runs on the treble band when the hit
     announced itself there - the stick click is the sharpest edge available, and the previous hit's
     low ringing is filtered out of the window - or on the full signal for a soft, bass-only hit (a chest). */
  var DEFAULTS2 = {
    hpHz: 40, loHz: 300, hiHz: 2000,
    hopMs: 0.667, riseLookMs: 4,
    /* A WINDOW PER BAND, sized to its pitch (2026-09-27). The bass band was read over 2 ms, but a 100 Hz
       cycle takes 10 ms, so a 2 ms window catches it at a random phase: plain rumble swung ~18 dB frame to
       frame there (measured: p10 -52, max -34.6 dB on noise alone) and passed as a hit. Treble noise read
       over 2 ms spans under 3 dB. Placement never uses these windows - AIC does that on the samples. */
    winMs: [12, 3, 2],
    sumDb: 12,         // the summed rise a hit needs
    bandFloorDb: 6,    // a band's rise only counts while that band is this far above its own noise
    strongDb: 12,      // ...and at least ONE band must stand this far above its noise. Three bands of plain
                       // noise each wobbling 4 dB summed to a "hit" (sweep 2026-09-27); no band of plain
                       // noise ever stands 12 dB clear of itself.
    holdMs: 8, peakMs: 8,
    preMs: 5           // AIC window starts this far before the trigger (was 12: that reached back into echoes)
  };
  function biquad(x, sr, type, fc) {
    var w = 2 * Math.PI * fc / sr, c = Math.cos(w), s = Math.sin(w), al = s / (2 * Math.SQRT1_2), b0, b1, b2;
    if (type === "lp") { b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2; } else { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; }
    var a0 = 1 + al, a1 = -2 * c / a0, a2 = (1 - al) / a0; b0 /= a0; b1 /= a0; b2 /= a0;
    var y = new Float32Array(x.length), x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (var i = 0; i < x.length; i++) { var v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v; }
    return y;
  }
  function envelope(y, hop, win) {
    var nF = Math.floor((y.length - win) / hop) + 1, E = new Float32Array(Math.max(0, nF));
    for (var f = 0; f < nF; f++) {
      var s = 0, base = f * hop;
      for (var j = 0; j < win; j++) { var v = y[base + j]; s += v * v; }
      E[f] = 10 * Math.log10(s / win + 1e-14);
    }
    return E;
  }

  function detectBands(x, sr, opts) {
    var o = {}, k;
    for (k in DEFAULTS2) o[k] = DEFAULTS2[k];
    for (k in (opts || {})) o[k] = opts[k];
    var y = highpass(x, sr, o.hpHz);
    var hiCut = Math.min(o.hiHz, sr * 0.4);
    var bands = [
      biquad(biquad(y, sr, "lp", o.loHz), sr, "lp", o.loHz),
      biquad(biquad(y, sr, "hp", o.loHz), sr, "lp", hiCut),
      biquad(biquad(y, sr, "hp", hiCut), sr, "hp", hiCut)
    ];
    var hop = Math.max(1, Math.round(sr * o.hopMs / 1000)), win = hop * 3;
    var wins = o.winMs.map(function (ms) { return Math.max(hop, Math.round(sr * ms / 1000)); });
    // each band's frame f covers the window that ENDS where the full-signal frame f ends, so all agree on "now"
    var Es = bands.map(function (b, i) {
      var E = envelope(b, hop, wins[i]), shift = Math.round((wins[i] - win) / hop), A = new Float32Array(Math.floor((y.length - win) / hop) + 1);
      for (var f = 0; f < A.length; f++) { var g = f - shift; A[f] = g >= 0 && g < E.length ? E[g] : (E.length ? E[0] : -140); }
      return A;
    });
    var Eall = envelope(y, hop, win);
    var nF = Eall.length;
    if (nF < 8) return [];
    var look = Math.max(3, Math.round(o.riseLookMs / o.hopMs));
    // the look-back for a band starts where that band's current window starts, so the rise compares
    // this window with the ones BEFORE it rather than with itself
    var skip = wins.map(function (w) { return Math.max(3, Math.round(w / hop)); });
    var hold = Math.round(o.holdMs / o.hopMs), peakF = Math.round(o.peakMs / o.hopMs);
    var fStep = 0.25, fUp = fStep / 9;
    var floors = Es.map(function (E) { return E[0]; });
    var lastTrig = -1e9, lastOnset = -1e9, out = [];

    for (var f = 1; f < nF; f++) {
      var sum = 0, contrib = [0, 0, 0], strong = false;
      for (var b = 0; b < 3; b++) {
        var E = Es[b];
        if (E[f] < floors[b]) floors[b] -= fStep; else floors[b] += fUp;
        if (f < 200 && E[f] < floors[b]) floors[b] = E[f];
        if (f < look + skip[b]) continue;
        /* a band stays out for its own window after a hit: the bass window is 12 ms, so it is still rising
           from the SAME hit after the 8 ms hold, and re-fired it as a second one (sweep 2026-09-27) */
        if (f - lastTrig < skip[b] + 2) continue;
        var hi = -Infinity;
        for (var q = f - skip[b] - look; q < f - skip[b] + 1; q++) if (E[q] > hi) hi = E[q];
        var r = E[f] - hi;
        if (r > 0 && E[f] > floors[b] + o.bandFloorDb) { sum += r; contrib[b] = r; }
        if (E[f] > floors[b] + o.strongDb) strong = true;
      }
      if (f - lastTrig < hold || sum < o.sumDb || !strong) continue;

      var pk = f;
      for (q = f; q < Math.min(nF, f + peakF); q++) if (Eall[q] > Eall[pk]) pk = q;
      // place on the treble band when the hit announced itself there, else on the full signal
      var sig = contrib[2] >= 0.4 * sum ? bands[2] : y;
      var trigS = f * hop;
      var a = Math.max(0, trigS - Math.round(sr * o.preMs / 1000), lastOnset + Math.round(sr * 0.002));
      var bEnd = Math.min(sig.length, pk * hop + win), pkS = pk * hop, pkV = 0;
      for (q = pk * hop; q < bEnd; q++) if (Math.abs(sig[q]) > pkV) { pkV = Math.abs(sig[q]); pkS = q; }
      var onset = aicPick(sig, a, Math.max(a + 8, pkS + 1));
      out.push({ sample: onset, t: onset / sr, peakDb: Eall[pk], riseDb: sum, band: sig === y ? "all" : "hi" });
      lastTrig = f; lastOnset = onset;
    }
    return out;
  }

  /* ================= LISTEN WITH THE MUSIC =================
     listen(samples, sr, expected, opts) -> { notes: [...], extras: [...] }
       expected: [{ t }] - where the music puts each note, in seconds on the RECORDING's clock (calibration
                 has already removed the device delay). Sorted.
       notes[i]: { found, sample, t, errMs, how } for expected[i]; errMs = found time - expected time.
       extras:   hits heard that belong to no note.

     Why (bench 2026-09-27): listening blind, every hit that stood 12 dB or more clear of what was already
     sounding was found - 100% - and every miss was a tap buried in the ring or room echo of the accent
     before it. The music tells us where to listen, so a note's own window can accept a smaller rise
     than the open recording can. TWO bars, never one:
       - an EXTRA hit (outside every note's window) needs the full blind bar, so ringing is never counted
         as something the player did;
       - a NOTE is heard if its window holds a blind hit, or else a smaller but real rise - in the
         treble band (the stick's click cuts through a dark room tail) or the full signal.
     A note the player SKIPPED must still come back "missed": the soft bar is checked against that on
     purpose (the `skips` condition in dev/corpus.js). */
  /* The soft bar, set by measurement (2026-09-27, 422 real soft notes vs 66 skipped ones across rooms,
     phone mics, noise and soft taps): in a SKIPPED note's window the echo's full-signal rise reached 7.5 dB
     and its treble rise 5.9 dB; real soft notes rose a median 5.4 dB full-signal but 8.0 dB in the treble -
     the stick's click is what an echo does not have. So the treble bar sits above the worst echo and the
     full-signal bar above the worst echo too; real taps under both are buried and stay "missed". */
  var LISTEN = { maxWinMs: 45, winFrac: 0.45, softRiseDb: 8, softRiseHiDb: 6.5, softFloorDb: 8, hiHz: 2000,
                 extraPeakMs: 8, extraSharpDb: 10, extraPreMs: 10, extraUnderDb: 12 };   // what an EXTRA must be: see below
  function listen(x, sr, expected, opts) {
    var o = {}, k;
    for (k in LISTEN) o[k] = LISTEN[k];
    for (k in (opts || {})) o[k] = opts[k];
    if (o.notch) x = notchAll(x, sr, o.notch);          // once, here; detect() below gets the filtered signal
    var blind = detect(x, sr, o.blind);
    var y = highpass(x, sr, 40), hiCut = Math.min(o.hiHz, sr * 0.4);
    var yh = biquad(biquad(y, sr, "hp", hiCut), sr, "hp", hiCut);
    var hop = Math.max(1, Math.round(sr * 0.000667)), win = hop * 3;
    var Eb = envelope(y, hop, win), Eh = envelope(yh, hop, win);
    function pct(E, p) { var s = Array.prototype.slice.call(E).sort(function (a, b) { return a - b; }); return s[Math.floor(s.length * p)] || -140; }
    var floorB = pct(Eb, 0.1), floorH = pct(Eh, 0.1);   // offline for now; the live version tracks them

    var n = expected.length, notes = new Array(n), used = new Array(blind.length);
    /* FLAMS (2026-09-27): a grace note is not on the grid - its distance before the main stroke is the
       player's flam width - so judging it against a grid spot mislabelled real flams (bench: graces
       unheard, then reported as extra hits, 25 ms "errors"). An expected entry with `graceOf: m` is the
       grace of main note m: the main note is judged against the music like any other, and the grace is
       looked for just BEFORE the main stroke that was actually played. */
    var mains = [];
    for (var i = 0; i < n; i++) if (expected[i].graceOf == null) mains.push(i);
    var wins = new Array(n);
    mains.forEach(function (i, k) {
      var gap = Infinity, e = expected[i].t;
      if (k > 0) gap = Math.min(gap, e - expected[mains[k - 1]].t);
      if (k + 1 < mains.length) gap = Math.min(gap, expected[mains[k + 1]].t - e);
      wins[i] = Math.min(o.maxWinMs / 1000, gap * o.winFrac);
    });

    /* 1. MAIN NOTES take the LOUDEST clear hit in their window, and the nearest only among near-equals
       (within 3 dB). "Nearest to the beat" handed a note its own room echo when the player was early:
       the real hit 17 ms before the beat, the echo landing closer to it (bench 2026-09-27). */
    mains.forEach(function (i) {
      var bestJ = -1;
      for (var j = 0; j < blind.length; j++) {
        if (used[j] || Math.abs(blind[j].t - expected[i].t) > wins[i]) continue;
        if (bestJ < 0) { bestJ = j; continue; }
        var dp = blind[j].peakDb - blind[bestJ].peakDb;
        if (dp > 3 || (dp > -3 && Math.abs(blind[j].t - expected[i].t) < Math.abs(blind[bestJ].t - expected[i].t))) bestJ = j;
      }
      if (bestJ >= 0) { used[bestJ] = true; notes[i] = { found: true, sample: blind[bestJ].sample, t: blind[bestJ].t, how: "clear" }; }
    });

    /* 2. an empty window: a smaller but real rise - and the FIRST one, not the biggest. Echo swells come
       after a hit, never before it; "biggest" took a swell 50 ms after a soft tap that did qualify. */
    var look = 6;
    function softIn(t0, t1) {
      var f0 = Math.max(look + 3, Math.floor(t0 * sr / hop)), f1 = Math.min(Eb.length - 1, Math.ceil(t1 * sr / hop));
      for (var f = f0; f <= f1; f++) {
        var hb = -Infinity, hh = -Infinity;
        for (var q = f - look; q < f - 2; q++) { if (Eb[q] > hb) hb = Eb[q]; if (Eh[q] > hh) hh = Eh[q]; }
        var rb = Eb[f] - hb, rh = Eh[f] - hh;
        var okB = rb >= o.softRiseDb && Eb[f] > floorB + o.softFloorDb;
        var okH = rh >= o.softRiseHiDb && Eh[f] > floorH + o.softFloorDb;
        if (!okB && !okH) continue;
        var hi = okH && (!okB || rh >= rb), sig = hi ? yh : y, trigS = f * hop;
        var a = Math.max(0, trigS - Math.round(sr * 0.005)), bEnd = Math.min(sig.length, trigS + Math.round(sr * 0.006)), pkS = trigS, pkV = 0;
        for (q = trigS; q < bEnd; q++) if (Math.abs(sig[q]) > pkV) { pkV = Math.abs(sig[q]); pkS = q; }
        var on = aicPick(sig, a, Math.max(a + 8, pkS + 1));
        return { found: true, sample: on, t: on / sr, how: hi ? "soft-treble" : "soft", rb: rb, rh: rh };
      }
      return null;
    }
    mains.forEach(function (i) {
      if (!notes[i]) notes[i] = softIn(expected[i].t - wins[i], expected[i].t + wins[i]) || { found: false, busy: busy(expected[i].t - wins[i], expected[i].t + wins[i]) };
    });

    /* NOT HEARD, BUT WAS ANYTHING THERE TO HEAR IT IN? (live view, 2026-09-27: "never show wrong red").
       If the window was loud - the ring of the note before it, a room tail - a soft tap may be buried in it
       and "missed" would be a guess. `busy` lets the page show that note as UNSURE instead of red. */
    function busy(t0, t1) {
      var f0 = Math.max(0, Math.floor(t0 * sr / hop)), f1 = Math.min(Eb.length - 1, Math.ceil(t1 * sr / hop)), mx = -Infinity;
      for (var f = f0; f <= f1; f++) if (Eb[f] > mx) mx = Eb[f];
      return mx > floorB + 18;
    }
    // 3. grace notes: just before the main stroke as played (or as written, if the main was not heard)
    for (i = 0; i < n; i++) {
      var m = expected[i].graceOf;
      if (m == null) continue;
      var anchor = notes[m] && notes[m].found ? notes[m].t : expected[m].t;
      var lo = anchor - 0.060, hi2 = anchor - 0.004, bj = -1;
      for (var j2 = 0; j2 < blind.length; j2++) {
        if (used[j2] || blind[j2].t < lo || blind[j2].t > hi2) continue;
        if (bj < 0 || Math.abs(blind[j2].t - (anchor - 0.025)) < Math.abs(blind[bj].t - (anchor - 0.025))) bj = j2;
      }
      if (bj >= 0) { used[bj] = true; notes[i] = { found: true, sample: blind[bj].sample, t: blind[bj].t, how: "clear" }; }
      else notes[i] = softIn(lo, hi2) || { found: false };
      if (notes[i].found && notes[m] && notes[m].found) notes[i].widthMs = (notes[m].t - notes[i].t) * 1000;
    }
    for (i = 0; i < n; i++) if (notes[i].found) notes[i].errMs = (notes[i].t - expected[i].t) * 1000;
    /* A QUIET PRE-SOUND IS NOT AN EXTRA HIT (2026-09-27, Anthony's third real take: every snap came in two
       parts, the fingers sliding and then the crack 11-21 ms later and 10-15 dB louder, and each slide was
       reported "Extra"). One hand cannot flam, and a flam the MUSIC asks for is claimed above as a grace,
       so an unclaimed sound less than 25 ms before a heard note and 10+ dB quieter than it is part of that
       note's stroke (a stick's graze, a snap's slide, a pad's rattle) - never something the player added. */
    var heard = [];
    for (i = 0; i < n; i++) if (notes[i] && notes[i].found) heard.push(notes[i]);
    var blindAt = {};
    blind.forEach(function (b, j) { blindAt[b.sample] = b; });
    /* AN EXTRA IS A STROKE, AND A STROKE IS SHARP (a real phone, 2026-11-11: Anthony's S22 playing 48 pad hits through its own
       speaker heard all 48 within 1.77 ms and reported 62 EXTRA hits. None was a hit. Each sat in the quiet between two hits,
       where the level sank and then came back up: the phone's own gain riding and the room, not a stick). Measured on that
       take: a real hit reaches its peak 0.5 to 3.5 ms after it starts and stands 16 to 48 dB over the 10 ms before it; the
       false ones took a median 22 ms to peak and stood a median 0.6 dB over what came before. So an unclaimed sound is an
       extra only if it has a stick's attack: at its peak within 8 ms, and 10 dB or more over the moment before it. A slow
       swell is never something the player did. dev/phone-takes.js holds that recording. */
    function energyDb(a, c) { var e = 0; a = Math.max(0, a | 0); c = Math.min(y.length, c | 0); for (var q = a; q < c; q++) e += y[q] * y[q]; return 10 * Math.log10(e / Math.max(1, c - a) + 1e-12); }
    function sharpEnough(s0) {
      var win = Math.max(8, Math.round(sr * 0.001)), hop = Math.max(4, win >> 1), best = -1e9, at = 0;
      for (var q = 0; q < sr * 0.06; q += hop) { var e = energyDb(s0 + q, s0 + q + win); if (e > best) { best = e; at = q; } }
      return at / sr * 1000 <= o.extraPeakMs && energyDb(s0, s0 + sr * 0.002) - energyDb(s0 - sr * o.extraPreMs / 1000, s0 - sr * 0.0005) >= o.extraSharpDb;
    }
    /* ...and it is in the range of what the player is playing: nothing more than 12 dB under the quietest note that was heard.
       (The nine that had a sharp enough edge on that take were 16 to 30 dB under its softest tap.) With no note heard at all
       there is nothing to measure against, and the sharpness bar stands alone. */
    var quietest = Infinity;
    for (var hq = 0; hq < heard.length; hq++) { var hb = blindAt[heard[hq].sample]; if (hb && hb.peakDb < quietest) quietest = hb.peakDb; }
    if (quietest === Infinity) quietest = -Infinity;
    var extras = blind.filter(function (b, j) {
      if (used[j]) return false;
      for (var h = 0; h < heard.length; h++) {
        var gap = heard[h].t - b.t, main = blindAt[heard[h].sample];
        if (gap > 0 && gap < 0.025 && main && b.peakDb <= main.peakDb - 10) return false;
      }
      return b.peakDb >= quietest - o.extraUnderDb && sharpEnough(b.sample);
    });
    return { notes: notes, extras: extras };
  }

  /* THE LISTENING PASS OF PLAY ALONG, as one rule both the page and the tests use (2026-11-12, after three tries on his phone went
     wrong in three different ways). The phone plays the exercise alone; from what the mic heard in that pass, this finds the phone's
     own notes and says whether the pass can be learned from.
       hits:  every hit heard from the start of the pass to 0.7 s past its end, { f: frame, pk: dB }
       sched: the frame each of the pass's n notes was scheduled at;  next: the frame the NEXT pass's first note was scheduled at
     Returns { verdict: "phone" | "playing" | "quiet", d[], pk[], delay, found, strays, spreadMs }:
       "quiet"   - no steady line of the phone's notes and few hits: the phone is too quiet to hear
       "playing" - someone is playing over it (each rule below came from one of his takes)
       "phone"   - learned: d[i] is where note i's own sound is heard, after its schedule */
  function learnPass(hits, sched, next, sr) {
    var n = sched.length, ds = [], i, p, q;
    for (i = 0; i < n; i++) hits.forEach(function (o) { var d = o.f - sched[i]; if (d > 0 && d < 0.7 * sr) ds.push({ i: i, d: d }); });
    ds.sort(function (x, y) { return x.d - y.d; });
    var best = null, W = 0.003 * sr;
    for (p = 0; p < ds.length; p++) {
      var seen = {}, m = 0;
      for (q = p; q < ds.length && ds[q].d - ds[p].d <= W; q++) if (!seen[ds[q].i]) { seen[ds[q].i] = 1; m++; }
      if (!best || m > best.n) best = { n: m, d: ds[p].d + W / 2 };
    }
    var out = { verdict: "quiet", d: [], pk: [], delay: best ? best.d : null, found: best ? best.n : 0, strays: 0, spreadMs: 0 };
    /* no steady line of the phone's notes: with plenty of hits that is someone playing over it (his v14 take: he played every pass
       and was told to turn the volume UP), with few it is the phone being too quiet */
    if (!best || best.n < Math.max(3, Math.ceil(n * 0.5))) { out.verdict = hits.length >= n ? "playing" : "quiet"; return out; }
    for (i = 0; i < n; i++) {
      var want = sched[i] + best.d, near = null;
      hits.forEach(function (o) { if (Math.abs(o.f - want) <= 0.004 * sr && (!near || o.pk > near.pk)) near = o; });
      out.d.push(near ? near.f - sched[i] : best.d); out.pk.push(near ? near.pk : -200);
    }
    /* STRAY HITS: off every one of the phone's notes AND louder than the loudest of them by 3 dB, at least 3 of them, and none from
       within 20 ms of the next pass's first note. His v15 take, quiet, was called "playing" by the old rule (2 hits about as loud as
       the phone's taps): a room echo 48 ms after a tap (-20 dB, under its accents' -19), one of the phone's own notes heard 5 ms off
       its place, and his first hit of the NEXT pass, 8 ms early. A player loud enough to be judged at all is 10 dB over the phone. */
    var loudest = -200; out.pk.forEach(function (v) { if (v > loudest) loudest = v; });
    out.strays = hits.filter(function (o) {
      if (o.f >= next + best.d - 0.02 * sr) return false;
      for (var j = 0; j < n; j++) if (Math.abs(o.f - (sched[j] + out.d[j])) <= 0.006 * sr) return false;
      return o.pk >= loudest + 3;
    }).length;
    /* ...and a person playing right on top of the phone's notes. The phone's own notes land within 0.08 to 0.29 ms of their middle
       for 3 notes in 4 (his takes of 2026-11-12); nobody plays that steadily, so over 0.7 ms is someone playing. Not the median:
       where the player is late the phone's own hit is the one found, so half the notes look exact even with someone playing. */
    var heard = [], dMid; for (i = 0; i < n; i++) if (out.pk[i] > -199) heard.push(out.d[i]);
    heard.sort(function (x, y) { return x - y; }); dMid = heard[heard.length >> 1];
    var res = heard.map(function (v) { return Math.abs(v - dMid); }).sort(function (x, y) { return x - y; });
    out.spreadMs = (res.length ? res[Math.floor(res.length * 0.75)] : 0) / sr * 1000;
    out.verdict = out.strays >= 3 || out.spreadMs > 0.7 ? "playing" : "phone";
    return out;
  }

  return { learnPass: learnPass, detect: detect, detectBands: detectBands, listen: listen, notchAll: notchAll, highpass: highpass, aicPick: aicPick, DEFAULTS: DEFAULTS, DEFAULTS2: DEFAULTS2 };
});
