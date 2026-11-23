// Fixtures for `bun run ui:preview src/renderer/src/work/formats/PreviewFrame.preview.tsx#PreviewFrame --width 864`.
export default [
  { name: "Word, as LibreOffice draws it, with what it drops and Check in Word", props: { moment: "word" } },
  { name: "With a page set-up: the Page section over the losses, and a kind's own row", props: { moment: "setup" } },
  { name: "Beside a thread (502px): the column folded, the format a menu, the Page button", props: { moment: "folded" } },
  { name: "At 400px: Edit as its glyph, no zoom", props: { moment: "tiny" } },
  { name: "PDF: the file itself", props: { moment: "pdf" } },
  { name: "After Check in Word: Word drew it, nothing is lost", props: { moment: "word-drew" } },
  { name: "24 pages: the thumbnail rail", props: { moment: "long" } },
  { name: "While it is drawn", props: { moment: "drawing" } },
  { name: "The renderer out of reach", props: { moment: "failed" } },
  { name: "Markdown: the file's own text", props: { moment: "markdown" } },
  { name: "A web page, sealed", props: { moment: "web" } },
];
