// Fixtures for `bun run ui:preview src/renderer/src/work/slides/show/Show.preview.tsx#ShowPreview --shot`:
// the presenter's view and the slideshow, as .temp-code/prototypes/work-editors/present.html draws them.
export default [
  { name: "Presenter's view: the first slide", props: { moment: "first" } },
  { name: "Presenter's view: a build next, past his target", props: { moment: "build" } },
  { name: "Presenter's view: the end of the show", props: { moment: "end" } },
  { name: "Presenter's view: the slideshow's display left; the screen is black", props: { moment: "gone" } },
  { name: "Presenter's view: reading the deck", props: { moment: "loading" } },
  { name: "Presenter's view at 400px", props: { moment: "narrow" } },
  { name: "Presenter's view: a slide with a video, paused", props: { moment: "video" } },
  { name: "The slideshow, with its bar (its window is dark in both themes)", props: { moment: "bar" } },
  { name: "The slideshow: the picker", props: { moment: "picker" } },
  { name: "The slideshow: the end", props: { moment: "over" } },
];
