// A preview page for `bun run ui:preview src/renderer/src/work/dashboards/DashboardCanvas.preview.tsx#DashboardPreview --props '{"state":"page"}'`:
// the dashboard kind alone in the canvas pane, its host a stand-in. States: `page` (figures, a chart, a table),
// `proposed` (an agent's block waiting for Accept), `stale` (a sheet it reads moved), `empty`, `failed` (the read
// failed), `loading`, and `lifeos-down` (read from LifeOS sheets while the box's LifeOS is signed out, the figures as
// of before). Rendered by nothing in the app.
import type { DashboardView, DashFrom } from "@shared/contract-work-dashboards";
import type { CanvasBodyProps } from "../canvas/kind";
import { CanvasKindAt } from "../kit.preview";
import { registry } from "../../lib/connection";
import { setLifeosStatus } from "../shell/lifeos";
import { Bar, Body } from "./DashboardCanvas";
import type { DashHost } from "./host";

type State = "page" | "proposed" | "stale" | "empty" | "failed" | "loading" | "lifeos-down";

const SHEET = { at: "lifeos", table: "sheets", id: "s1" } as const;
const from = (range: string, counts: string): DashFrom => ({ sheet: SHEET, sheetTitle: "Spring LAN budget", range, counts });
const AS_OF = Date.now() - 12 * 60_000;

const PAGE: DashboardView = {
  itemId: "dash",
  rev: 1,
  title: "Spring LAN budget",
  asOf: AS_OF,
  stale: false,
  failed: null,
  blocks: [
    {
      id: "b1",
      kind: "figures",
      figures: [
        { id: "f1", label: "Spent", sub: "of $18,400", format: "money", from: { ...from("Budget!E2:E20", "Amount, summed where Paid is Yes"), agg: "sum" }, value: "$11,240" },
        { id: "f2", label: "Left", format: "money", from: { ...from("Budget!E22", "Budget less spent"), agg: "sum" }, value: "$7,160" },
        { id: "f3", label: "Sponsor pledges", sub: "3 sponsors", format: "money", from: { ...from("Sponsors!C2:C9", "Pledged, summed"), agg: "sum" }, value: "$6,000" },
      ],
    },
    {
      id: "b2",
      kind: "chart",
      title: "Spent by month",
      format: "money",
      from: { ...from("Budget!F2:F7", "Spent each month"), labels: "Budget!A2:A7" },
      bars: [
        { label: "Jul", value: 1200 },
        { label: "Aug", value: 900 },
        { label: "Sep", value: 2600 },
        { label: "Oct", value: 3100 },
        { label: "Nov", value: 3440 },
      ],
    },
    {
      id: "b3",
      kind: "table",
      title: "Largest lines",
      from: from("Budget!A1:C5", "The four largest lines"),
      head: ["Line", "Vendor", "Amount"],
      rows: [
        ["Ballroom and power", "Purdue Memorial Union", "9,200"],
        ["Equipment rental", "Midwest AV", "5,600"],
        ["Staff meals", "RecWell catering", "2,100"],
        ["Prizes", "Dana Lee", "1,500"],
      ],
      numeric: [false, false, true],
    },
  ],
};

function viewOf(state: State): DashboardView {
  if (state === "proposed")
    return { ...PAGE, blocks: [...PAGE.blocks, { id: "b4", kind: "text", text: "Prizes are under budget by $140; the headsets came in cheaper.", proposed: { by: "agent:local:t1", reason: "Said what moved since last week", at: AS_OF } }] };
  if (state === "stale") return { ...PAGE, stale: true };
  if (state === "empty") return { ...PAGE, blocks: [] };
  if (state === "lifeos-down") return { ...PAGE, failed: "This host is not signed in to LifeOS", lifeos: "signed-out" };
  if (state === "failed") return { ...PAGE, failed: "The sheet Spring LAN budget was moved or deleted", blocks: [] };
  return PAGE;
}

const never = new Promise<never>(() => undefined);
function hostOf(state: State): DashHost {
  const view = viewOf(state);
  return {
    open: () => (state === "loading" ? never : Promise.resolve(view)),
    refresh: () => Promise.resolve(view),
    review: () => Promise.resolve(view),
    openSheet: async () => undefined,
    watch: () => () => undefined,
  };
}

export function DashboardPreview({ state = "page" }: { state?: State }) {
  const host = hostOf(state);
  if (state === "lifeos-down") {
    Object.assign(registry, { environment: (id: string) => ({ id, name: "The box" }) });
    setLifeosStatus("local", { lifeos: { state: "signed-out" }, keys: [] });
  }
  const parts = {
    Body: (props: CanvasBodyProps) => <Body {...(props as CanvasBodyProps<undefined>)} host={host} />,
    Bar: (props: CanvasBodyProps) => <Bar {...(props as CanvasBodyProps<undefined>)} host={host} />,
  };
  return <CanvasKindAt id={`dash-${state}`} kind="dashboard" title="Spring LAN budget" parts={parts} height={state === "page" || state === "proposed" || state === "lifeos-down" ? 720 : 420} />;
}
