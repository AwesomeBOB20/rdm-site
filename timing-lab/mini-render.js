/* THE ONLINE TEST PAGE'S MUSIC DRAWING (2026-11-11, Anthony: "put the test page online so we can continue").
 * The test page at home draws with the tools' own renderer (shared/rdm-vexflow.js). That file is the paid product's code, kept in
 * the private vault, and the website is a public repository, so the online copy does not carry it. This draws the Timing Lab's
 * exercises with plain VexFlow (a public library, loaded from the CDN by the page) and reports each note's place in the same
 * shape: notes[bar][note] = { x, cTop, cBot }, which is all the page needs to put its marks on the notes.
 * 2026-11-12: also the catalog exercises ("Put another exercise inside of this website"): rests, dotted notes, any meter (7/8),
 * triplets, and a diddle's slash. */
(function () {
  "use strict";
  function render(rdm, el, opts) {
    var VF = window.Vex && window.Vex.Flow;
    if (!VF) throw new Error("VexFlow did not load");
    el.innerHTML = "";
    var W = Math.max(280, (opts && opts.width) || 320), bars = rdm.measures.length, perRow = W >= 560 ? 2 : 1, rowH = 120;
    var rows = Math.ceil(bars / perRow), renderer = new VF.Renderer(el, VF.Renderer.Backends.SVG);
    renderer.resize(W, rows * rowH + 6);
    var ctx = renderer.getContext(), bw = (W - 12) / perRow, out = { notes: [] }, sig = [4, 4];
    rdm.measures.forEach(function (m, mi) {
      if (m.timeSig) sig = m.timeSig;
      var row = Math.floor(mi / perRow), col = mi % perRow, st = new VF.Stave(6 + col * bw, 4 + row * rowH, bw);
      if (col === 0) st.addClef("percussion");
      if (m.timeSig) st.addTimeSignature(m.timeSig.join("/"));
      if (mi === bars - 1) st.setEndBarType(VF.Barline.type.END);
      st.setContext(ctx).draw();
      var notes = m.events.map(function (e) {
        var n = new VF.StaveNote({ keys: [e.rest ? "b/4" : "c/5"], duration: e.dur + (e.dots ? "d".repeat(e.dots) : "") + (e.rest ? "r" : ""), stem_direction: 1 });
        if (e.dots) for (var k = 0; k < e.dots; k++) VF.Dot.buildAndAttach([n], { all: true });
        if (e.rest) return n;
        if (e.accent) n.addModifier(new VF.Articulation("a>").setPosition(VF.Modifier.Position.ABOVE), 0);
        if (e.roll) n.addModifier(new VF.Tremolo(e.roll), 0);
        if (e.stick1) n.addModifier(new VF.Annotation(e.stick1).setVerticalJustification(VF.Annotation.VerticalJustify.BOTTOM).setFont("Arial", 11, "bold"), 0);
        return n;
      });
      var voice = new VF.Voice({ num_beats: sig[0], beat_value: sig[1] }).setMode(VF.Voice.Mode.SOFT).addTickables(notes);
      /* the tuplet only for its timing; its number is drawn below by hand, over the middle of the group: VexFlow put the "3" UNDER
         accented groups, on top of the stickings (Triplet Sevens, 2026-11-12) */
      var tuplets = (m.tuplets || []).map(function (t) { return { t: t, vf: new VF.Tuplet(t.idx.map(function (i) { return notes[i]; }), { num_notes: t.num || 3, notes_occupied: t.inSpaceOf || 2 }) }; });
      var beams = (m.beams || []).filter(function (b) { return b.every(function (i) { return notes[i] && !m.events[i].rest; }) && b.length > 1; }).map(function (b) { return new VF.Beam(b.map(function (i) { return notes[i]; })); });
      new VF.Formatter().joinVoices([voice]).formatToStave([voice], st);
      voice.draw(ctx, st);
      beams.forEach(function (b) { b.setContext(ctx).draw(); });
      tuplets.forEach(function (q) {
        if (q.t.show === false) return;
        var ns = q.t.idx.map(function (i) { return notes[i]; }), x0 = ns[0].getNoteHeadBeginX(), x1 = ns[ns.length - 1].getNoteHeadEndX(), y = Infinity;
        ns.forEach(function (n) { if (!n.isRest()) y = Math.min(y, n.getStemExtents().topY); });
        if (!isFinite(y)) y = st.getYForLine(0);
        ctx.save(); ctx.setFont("Times", 15, "bold italic"); ctx.fillText(String(q.t.num || 3), (x0 + x1) / 2 - 4, y - 6); ctx.restore();
      });
      var top = st.getYForLine(0) - 14, bot = st.getYForLine(4) + 26;
      out.notes[mi] = notes.map(function (n) { return { x: (n.getNoteHeadBeginX() + n.getNoteHeadEndX()) / 2, cTop: top, cBot: bot }; });
    });
    return out;
  }
  window.RDMRender = { render: render };
})();
