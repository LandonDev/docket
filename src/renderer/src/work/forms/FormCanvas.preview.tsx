// A preview page for `bun run ui:preview src/renderer/src/work/forms/FormCanvas.preview.tsx#FormPreview --props '{"state":"draft"}'`:
// the form kind alone in the canvas pane, its host a stand-in. States: `draft` (the questions), `suggested` (an
// agent's change waiting), `open` (published, its link), `responses` (the answers), `closed` and `loading`.
// Rendered by nothing in the app.
import type { FormBody, FormResponses, FormView } from "@shared/contract-work-forms";
import type { CanvasBodyProps } from "../canvas/kind";
import { CanvasKindAt, usePressNamed } from "../kit.preview";
import { Bar, Body } from "./FormCanvas";
import type { FormHost } from "./host";

type State = "draft" | "suggested" | "open" | "responses" | "closed" | "loading";

const BODY: FormBody = {
  title: "Spring LAN registration",
  description: "Saturday, April 10, North and South Ballrooms. Bring your own peripherals.",
  questions: [
    { id: "name", label: "Name", type: "short", required: true },
    { id: "game", label: "Game", type: "choice", required: true, options: ["Valorant", "Rocket League", "Super Smash Bros. Ultimate"] },
    { id: "diet", label: "Dietary needs", type: "long", required: false },
  ],
};
const PUBLISHED = Date.now() - 2 * 86_400_000;
const LINK = "https://tempcode.example.com/f/AbCdEfGhIjKlMnOp";

const RESPONSES: FormResponses = {
  rev: 4,
  columns: [
    { id: "name", label: "Name" },
    { id: "game", label: "Game" },
    { id: "diet", label: "Dietary needs" },
    { id: "submitted", label: "Submitted" },
  ],
  rows: [
    ["Marcus Lee", "Rocket League", "Vegetarian", "2026-11-19 13:40"],
    ["Ava Thompson", "Valorant", "", "2026-11-19 13:52"],
    ["Jordan Kim", "Valorant", "No peanuts", "2026-11-19 12:18"],
  ],
  count: 3,
  cut: false,
};

function viewOf(state: State): FormView {
  const base: FormView = { itemId: "form", rev: 1, body: BODY, state: "draft", mode: "suggests", suggestions: [], link: null, publishedAt: null, closedAt: null, held: null, sheet: null, written: null };
  if (state === "suggested")
    return { ...base, suggestions: [{ id: "sg1", op: "add", question: { id: "shirt", label: "T-shirt size", type: "choice", required: false, options: ["S", "M", "L", "XL"] }, after: "game", reason: "Dana Lee asked for shirt sizes", by: "agent:local:t1", at: PUBLISHED }] };
  const published = { ...base, state: "open" as const, link: LINK, publishedAt: PUBLISHED, sheet: { at: "lifeos" as const, table: "sheets" as const, id: "s1" } };
  if (state === "open" || state === "responses") return published;
  if (state === "closed") return { ...published, state: "closed", closedAt: Date.now() - 3_600_000 };
  return base;
}

const never = new Promise<never>(() => undefined);
function hostOf(state: State): FormHost {
  const view = viewOf(state);
  const same = (): Promise<FormView> => Promise.resolve(view);
  return {
    open: () => (state === "loading" ? never : same()),
    save: same,
    review: same,
    mode: same,
    publish: same,
    close: same,
    responses: () => Promise.resolve(RESPONSES),
    openSheet: async () => undefined,
    watch: () => () => undefined,
  } as FormHost;
}

export function FormPreview({ state = "draft" }: { state?: State }) {
  const host = hostOf(state);
  usePressNamed(state === "responses" ? "Responses" : null, 80);
  const parts = {
    Body: (props: CanvasBodyProps) => <Body {...(props as CanvasBodyProps<never>)} host={host} />,
    Bar: (props: CanvasBodyProps) => <Bar {...(props as CanvasBodyProps<never>)} host={host} />,
  };
  return <CanvasKindAt id={`form-${state}`} kind="form" title="Spring LAN registration" parts={parts} height={state === "loading" ? 360 : 620} />;
}
