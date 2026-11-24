// A preview page for `bun run ui:preview src/renderer/src/work/msforms/MsFormCanvas.preview.tsx#MsFormPreview --props '{"state":"draft"}'`:
// the Microsoft form kind alone in the canvas pane, its host a stand-in. States: `draft` (Collect responses),
// `collecting` (the link, Copy and Close form), `closed` (the closed line and Reopen), `responses` (the answers)
// and `loading`. The Form half is the Office-live guest, which a preview window cannot draw: it shows the guest's
// own "Open in Forms on the Web" stand-in. Rendered by nothing in the app.
import type { MsFormResponses, MsFormView } from "@shared/contract-work-msforms";
import type { CanvasBodyProps } from "../canvas/kind";
import { CanvasKindAt, usePressNamed } from "../kit.preview";
import type { MsFormHost } from "./host";
import { Bar, Body } from "./MsFormCanvas";

type State = "draft" | "collecting" | "closed" | "responses" | "loading";

const FORM = "Ob0wQVN8nEGx5YdY1tY_IQaWFXVrVqJAiq2zrvrFVrNURDVET1gyWlpLNkJXOUsyWEJXNFlKMzMxVC4u";
const BASE: MsFormView = {
  workspaceId: "w1",
  formId: FORM,
  tenant: "purdue0",
  title: "Spring intramural sign-up",
  folder: { libraryId: "lib", path: "Esports", siteUrl: "https://purdue0.sharepoint.com/sites/RecWell", label: "RecWell › Documents › Esports" },
  workbook: null,
  state: "draft",
  mode: "suggests",
  settings: { accepting: false, orgOnly: true, recordName: true, onePerPerson: true },
  questions: [
    { title: "Which night works?", type: "choice", options: ["Monday", "Tuesday", "Wednesday"], required: true },
    { title: "Anything we should know?", type: "text", long: true, required: false },
  ],
  rev: 3,
  readAt: Date.now() - 60_000,
  answersReadAt: null,
  count: 0,
  lastAnswerAt: null,
  check: "hour",
  suggestions: [],
  held: null,
  link: null,
  madeBy: "owner",
  signedInAs: "dummy@example.edu",
  updatedAt: Date.now(),
  unseen: 0,
  stopped: null,
  closedAt: null,
};

const RESPONSES: MsFormResponses = {
  rev: 3,
  columns: [
    { id: "email", label: "Email" },
    { id: "name", label: "Name" },
    { id: "q1", label: "Which night works?" },
    { id: "q2", label: "Anything we should know?" },
    { id: "done", label: "Completion time" },
  ],
  rows: [
    ["athompson@purdue.example", "Ava Thompson", "Tuesday", "", "2026-11-24 14:02"],
    ["mlee@purdue.example", "Marcus Lee", "Monday", "Late after 8", "2026-11-24 13:40"],
    ["jkim@purdue.example", "Jordan Kim", "Tuesday", "", "2026-11-24 12:18"],
  ],
  count: 3,
  cut: false,
  at: Date.now() - 30_000,
  stale: false,
  none: false,
};

function viewOf(state: State): MsFormView {
  const link = `https://forms.cloud.microsoft/Pages/ResponsePage.aspx?id=${FORM}`;
  if (state === "collecting" || state === "responses") return { ...BASE, state: "collecting", link, count: 3, unseen: state === "collecting" ? 2 : 0, settings: { ...BASE.settings, accepting: true } };
  if (state === "closed") return { ...BASE, state: "closed", link, count: 3, closedAt: Date.now() - 3_600_000 };
  return BASE;
}

const never = new Promise<never>(() => undefined);
function hostOf(state: State): MsFormHost {
  const view = viewOf(state);
  const same = (): Promise<MsFormView> => Promise.resolve(view);
  return {
    get: () => (state === "loading" ? never : same()),
    collect: same,
    close: same,
    mode: same,
    check: same,
    review: same,
    responses: () => Promise.resolve(RESPONSES),
    refresh: same,
    seen: same,
    prefill: async () => ({ link: `https://forms.cloud.microsoft/Pages/ResponsePage.aspx?id=${FORM}` }),
    watch: () => () => undefined,
  };
}

export function MsFormPreview({ state = "draft" }: { state?: State }) {
  const host = hostOf(state);
  usePressNamed(state === "responses" ? "Responses" : null, 80);
  const parts = {
    Body: (props: CanvasBodyProps) => <Body {...(props as CanvasBodyProps<never>)} host={host} />,
    Bar: (props: CanvasBodyProps) => <Bar {...(props as CanvasBodyProps<never>)} host={host} />,
  };
  return <CanvasKindAt id={`msform-${state}`} kind="msform" title="Spring intramural sign-up" parts={parts} height={state === "loading" ? 360 : 560} />;
}
