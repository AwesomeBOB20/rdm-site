/* THE ONLINE TEST PAGE'S MUSIC DRAWING (2026-11-11, Anthony: "put the test page online so we can continue").
 * The test page at home draws with the tools' own renderer (shared/rdm-vexflow.js). That file is the paid product's code, kept in
 * the private vault, and the website is a public repository, so the online copy does not carry it. This draws the Timing Lab's
 * eight one-bar exercises with plain VexFlow (a public library, loaded from the CDN by the page) and reports each note's place in
 * the same shape: notes[bar][note] = { x, cTop, cBot }, which is all the page needs to put its marks on the notes. */
(function () {
  "use strict";
  function render(rdm, el, opts) {
    var VF = window.Vex && window.Vex.Flow;
    if (!VF) throw new Error("VexFlow did not load");
    el.innerHTML = "";
    var W = Math.max(280, (opts && opts.width) || 320), bars = rdm.measures.length, perRow = W >= 560 ? 2 : 1, rowH = 120;
    var rows = Math.ceil(bars / perRow), renderer = new VF.Renderer(el, VF.Renderer.Backends.SVG);
    renderer.resize(W, rows * rowH + 6);
    var ctx = renderer.getContext(), bw = (W - 12) / perRow, out = { notes: [] };
    rdm.measures.forEach(function (m, mi) {
      var row = Math.floor(mi / perRow), col = mi % perRow, st = new VF.Stave(6 + col * bw, 4 + row * rowH, bw);
      if (col === 0) st.addClef("percussion");
      if (m.timeSig) st.addTimeSignature(m.timeSig.join("/"));
      if (mi === bars - 1) st.setEndBarType(VF.Barline.type.END);
      st.setContext(ctx).draw();
      var notes = m.events.map(function (e) {
        var n = new VF.StaveNote({ keys: ["c/5"], duration: e.dur, stem_direction: 1 });
        if (e.accent) n.addModifier(new VF.Articulation("a>").setPosition(VF.Modifier.Position.ABOVE), 0);
        if (e.stick1) n.addModifier(new VF.Annotation(e.stick1).setVerticalJustification(VF.Annotation.VerticalJustify.BOTTOM).setFont("Arial", 11, "bold"), 0);
        return n;
      });
      var voice = new VF.Voice({ num_beats: 4, beat_value: 4 }).setMode(VF.Voice.Mode.SOFT).addTickables(notes);
      var tuplets = (m.tuplets || []).map(function (t) { return new VF.Tuplet(t.idx.map(function (i) { return notes[i]; }), { num_notes: 3, notes_occupied: 2, bracketed: false }); });
      var beams = (m.beams || []).map(function (b) { return new VF.Beam(b.map(function (i) { return notes[i]; })); });
      new VF.Formatter().joinVoices([voice]).formatToStave([voice], st);
      voice.draw(ctx, st);
      beams.forEach(function (b) { b.setContext(ctx).draw(); });
      tuplets.forEach(function (t) { t.setContext(ctx).draw(); });
      var top = st.getYForLine(0) - 14, bot = st.getYForLine(4) + 26;
      out.notes[mi] = notes.map(function (n) { return { x: (n.getNoteHeadBeginX() + n.getNoteHeadEndX()) / 2, cTop: top, cBot: bot }; });
    });
    return out;
  }
  window.RDMRender = { render: render };
})();
