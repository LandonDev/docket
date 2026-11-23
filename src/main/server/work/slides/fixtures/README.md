# Slides test fixtures

- `04-groups.pptx`: two slides with grouped freeform shapes, saved by Microsoft
  PowerPoint (its `docProps/app.xml` says so). From LibreOffice's core test data,
  under the Mozilla Public License 2.0 (MPL-2.0). It is here as data only: nothing
  links it. deck.test.ts uses it to prove the byte rule on a file python-pptx has
  never saved.
- `12-feature-probes.pptx`: ten slides made for the editors plan's slides lab by
  python-pptx (`.temp-code/plans/editors/_research/labs/slides/make_decks.py`,
  `make_features`): a theme swatch, shrink-to-fit text, a gradient with a shadow, a
  scaled group, a rotated and flipped group, a rotated box, a cropped picture, a
  table, three charts, a video and a sound (both generated test signals), two click
  reveals with a fade and a push, a hidden slide. Ours; no outside content.
- `feature-pixels.json`: where LibreOffice 26.8.3 drew eight flat-filled shapes of
  that deck at 1920 by 1080 (the box around each fill's pixels). The outline's
  boxes are held to these within 2 px (deck.test.ts).
- `kinds.pptx`: one slide with one shape of each kind a hand might pick, each in
  one flat colour (an ellipse, an arrow, a rounded box, an ellipse turned 30
  degrees, a triangle, a filled text box, a picture, a table, a thick connector, a
  chart, a video by its poster). Ours, made by `kinds-make.py` with python-pptx.
- `kinds-pixels.json`: how far each of those shapes' own box is from the pixels
  LibreOffice 26.8.3 drew for it at 1920 by 1080, measured by `kinds-measure.py`
  (PyMuPDF) on LibreOffice's PDF of the deck. This is the box test that decides
  which kinds can be picked on the stage (`PICKABLE` in the renderer's
  `work/slides/geometry.ts`; `boxes.test.ts` holds the table to these numbers).
  To measure again: `python -I kinds-make.py out.pptx tmpdir`, inspect it with the
  deck tool, export it with LibreOffice's `impress_pdf_Export`, then
  `python -I kinds-measure.py out.pdf outline.json tmpdir/targets.json 1920 measured.json`.
- `steps-kinds.pptx` and `steps-talk.pptx`: the show's build decks, made by
  `steps-make.py` with python-pptx and timing XML written the way PowerPoint
  writes it (`python -I steps-make.py steps-kinds.pptx steps-talk.pptx
  <ffmpeg>`; ffmpeg makes the one second of test video). `steps-kinds` holds
  one kind of timing a slide, its title naming it: presses, with-previous and
  after-previous, exits, paragraph builds (one anchored in the middle and
  shrunk to fit), what starts by itself, a video with PowerPoint's own play
  and pause and a caption, a group, a fly-in, and each kind the reader shows
  whole (a trigger, an emphasis held, a motion path, a nesting it does not
  know, a chart by series). `steps-talk` is a short talk: bullets with a
  sub-point, a picture after its caption, a box that leaves for another, a
  chart, numbered footers. Ours; no outside content. `steps-kinds.pptx` is a
  test of our reader, not a deck PowerPoint made: its slide 9 nests an effect
  one level deeper than PowerPoint writes, so PowerPoint asks to repair the
  file (`.temp-code/plans/landed/SLD679-powerpoint-proof.md`, part B; with
  that slide's timing taken out it opens clean). `steps-talk.pptx` and the
  feature deck open in PowerPoint as they are.
- `steps-kinds.json` and `steps-talk.json`: each slide's id, title, timing
  tree and shapes as the deck tool reads them, which `builds.test.ts` reads;
  `steps.gate.test.ts` holds them equal to what the tool reads today.
