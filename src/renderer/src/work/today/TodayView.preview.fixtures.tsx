/** TodayPreview's states for `bun run ui:preview`: the day as picked, each state of the States table, and the held sheet's body. */
export const fixtures = [
  { name: "The day", props: { state: "day" } },
  { name: "Folds open", props: { state: "unfolded" } },
  { name: "First open: sections that have never answered", props: { state: "bones" } },
  { name: "Empty sections, meetings over", props: { state: "empty" } },
  { name: "A host did not answer, another is offline", props: { state: "hosts" } },
  { name: "LifeOS refused one read", props: { state: "refused" } },
  { name: "LifeOS did not answer", props: { state: "lifeos-down" } },
  { name: "Not signed in to LifeOS", props: { state: "signed-out" } },
  { name: "All clear", props: { state: "clear" } },
  { name: "All clear, the day's meetings over", props: { state: "evening" } },
  { name: "With the other pillars' rows: clashes, Messages, Owed, the review", props: { state: "pillars" } },
  { name: "No jobs yet", props: { state: "no-jobs" } },
  { name: "The held sheet", props: { state: "sheet" } },
  { name: "The held sheet, the second of a run", props: { state: "sheet-next" } },
];
