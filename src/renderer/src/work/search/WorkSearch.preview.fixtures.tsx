import type { PreviewState } from "./WorkSearch.preview";

/** One fixture a state of the picker (docs/DESIGN.md "Work search"). */
const fixtures: { name: string; props: { state: PreviewState } }[] = [
  { name: "Nothing typed: Recent", props: { state: "recent" } },
  { name: "Results across jobs", props: { state: "across" } },
  { name: "A row he moved to", props: { state: "moved" } },
  { name: "One job", props: { state: "one-job" } },
  { name: "One kind: all mail", props: { state: "one-kind" } },
  { name: "A source still out", props: { state: "waiting" } },
  { name: "LifeOS signed out", props: { state: "lifeos" } },
  { name: "Nothing found", props: { state: "nothing" } },
  { name: "Nothing found in one job", props: { state: "nothing-in-job" } },
];
export default fixtures;
