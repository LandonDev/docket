// The Microsoft form bar's four faces and its Responses half, for `bun run ui:preview` (MsFormCanvas.preview.tsx).
export const fixtures = [
  { name: "Draft: Collect responses", props: { state: "draft" } },
  { name: "Collecting: the link", props: { state: "collecting" } },
  { name: "Closed", props: { state: "closed" } },
  { name: "Responses", props: { state: "responses" } },
  { name: "Loading", props: { state: "loading" } },
  { name: "A change waiting", props: { state: "waiting" } },
  { name: "A change being written", props: { state: "applying" } },
];
