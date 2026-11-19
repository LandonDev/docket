// A preview frame for `bun run ui:preview src/renderer/src/work/browser/BrowserCanvas.preview.tsx#BrowserPreview --width 864`:
// the live browser in the canvas pane beside a thread, as the approved page draws it
// (.temp-code/prototypes/work-workspaces-2/browser.html, "Watch, and take over"), with
// a picture of the site in place of the live window a static page cannot stream.
import type { BrowserState } from "@shared/contract-work-browser";
import type { OutboxItem } from "@shared/contract-work-outbox";
import type { CanvasItem, CanvasKind } from "@shared/work";
import { Composer } from "../../chrome/Composer";
import { composerFixtureBase } from "../../chrome/Composer.fixtures";
import { defineChunk } from "../../lib/lazyChunk";
import { workCanvasChunk } from "../../surfaces/chunks";
import { ChatFooter } from "../../surfaces/threads/chatSlots";
import { CanvasSeat } from "../canvas/CanvasSeat";
import type { CanvasBodyProps, CanvasKindDef } from "../canvas/kind";
import { CANVAS } from "../canvas/registry";
import { applyCanvasPush, resetCanvasStore } from "../canvas/store";
import * as BrowserCanvas from "./BrowserCanvas";
import { CONCUR_PAGE } from "./BrowserCanvas.preview.fixtures";

export type BrowserMoment = "driving" | "took" | "held" | "signin" | "done" | "loading";

void workCanvasChunk.load();

const MARK = JSON.stringify(["com.google.Chrome", ["textField|Hotel|$389.20", "textField|Mileage|$184.20", "textField|Meals|$39.04"]]);
const SUBMIT = {
  ref: { at: "host", id: "h1" },
  kind: "computer.act",
  sessionId: "",
  workspaceId: "ws",
  sector: "purdue",
  summary: "Click Submit Report in Google Chrome",
  verb: "Submit",
  account: null,
  state: "live",
  payload: { app: { name: "Google Chrome", bundleId: "com.google.Chrome" }, label: "Submit", mark: MARK },
  createdAt: 0,
  decidedBy: null,
  decidedAt: null,
  n: 1,
  why: "screen",
  grantId: null,
  error: null,
  result: null,
  routineRunId: null,
  updatedAt: 0,
} as OutboxItem;

function data(moment: BrowserMoment, sessionId: string): BrowserCanvas.Browser {
  if (moment === "loading") return { state: null, held: null, entry: null, live: [] };
  const state: BrowserState = {
    sessionId,
    driver: moment === "took" ? "owner" : "agent",
    needs: moment === "signin" ? "Concur wants you to sign in" : null,
    site: { url: moment === "signin" ? "https://login.purdue.edu" : "https://us2.concursolutions.com/report", name: "Concur" },
    sources: [
      { field: "Hotel", source: "Hilton folio.pdf, page 1" },
      { field: "Mileage", source: "412 miles at $0.447, from Maps" },
      { field: "Meals", source: "3 receipts in Travel, added up" },
    ],
    since: 1,
  };
  const held = moment === "held" ? { ...SUBMIT, sessionId } : moment === "done" ? { ...SUBMIT, sessionId, state: "sent" as const, decidedAt: new Date(2026, 10, 19, 14, 14).getTime() } : null;
  return { state, held, entry: null, live: [] };
}

export function BrowserPreview({ moment = "driving" }: { moment?: BrowserMoment }) {
  resetCanvasStore();
  const sessionId = `preview-browser-${moment}`;
  const itemId = `${sessionId}-item`;
  const item: CanvasItem = { id: itemId, sessionId, workspaceId: "ws", kind: "browser" as CanvasKind, title: "Report: Columbus trip", source: { at: "browser", host: "local", sessionId }, state: "open", position: 0, rev: 0, createdAt: 0, updatedAt: 0 };
  const seam = { data: data(moment, sessionId), picture: moment === "loading" ? undefined : <img src={CONCUR_PAGE} alt="" className="block w-full rounded-lg outline outline-1 -outline-offset-1 outline-image-outline" /> };
  const module = {
    Body: (props: CanvasBodyProps) => <BrowserCanvas.Body {...props} {...seam} />,
    Bar: (props: CanvasBodyProps) => <BrowserCanvas.Bar {...props} {...seam} />,
  };
  const chunk = defineChunk(`preview-browser-${moment}`, () => Promise.resolve(module));
  void chunk.load();
  const kinds: Record<CanvasKind, CanvasKindDef> = { ...CANVAS, browser: { ...CANVAS.browser, chunk: chunk as never } };
  applyCanvasPush({ sessionId, items: [item], opened: itemId });
  return (
    <div className="flex h-[560px] w-full overflow-hidden rounded-xl border border-border">
      <CanvasSeat session={{ id: sessionId, environmentId: "local" }} kinds={kinds}>
        <div className="flex min-h-0 flex-1 flex-col justify-end">
          <ChatFooter slots={{ transcript: null, strip: null, composer: <Composer {...composerFixtureBase} sessionId={sessionId} /> }} />
        </div>
      </CanvasSeat>
    </div>
  );
}
