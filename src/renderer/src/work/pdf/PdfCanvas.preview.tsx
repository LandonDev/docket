// A preview frame for `bun run ui:preview src/renderer/src/work/pdf/PdfCanvas.preview.tsx#PdfPreview --width 864`:
// the PDF kind in the canvas pane beside a thread, as the approved page draws
// it (.temp-code/prototypes/work-workspaces-2/pdf.html, "The page, and ask"),
// on a file of words drawn as paper in place of pdf.js.
import type { PdfView } from "@shared/contract-work-pdf";
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
import { deliverCite } from "./cite";
import type { PdfEngine } from "./engine";
import { navOf } from "./nav";
import * as PdfCanvas from "./PdfCanvas";
import { contractPages, formPage, guidePages, type PreviewPage } from "./PdfCanvas.preview.fixtures";
import { fakeDoc, fakeEngine, fakePdfHost, field, pdfView } from "./testkit";

export type PdfMoment = "reading" | "fill" | "cite" | "find" | "long" | "loading" | "locked" | "moved";

void workCanvasChunk.load();

const never: PdfEngine = { open: () => new Promise(() => undefined) };

function setUp(moment: PdfMoment): { view: PdfView; pages: PreviewPage[]; engine?: PdfEngine } {
  if (moment === "fill") {
    return {
      pages: [formPage()],
      view: pdfView({
        fields: [
          field("org", { label: "Organization", bbox: [0.1, 0.236, 0.9, 0.262], state: "proposed", proposed: "Purdue Esports, RecWell", provenance: [{ kind: "file", label: "Purdue profile" }], by: "agent:box:t" }),
          field("name", { label: "Contact name", bbox: [0.1, 0.306, 0.48, 0.332], state: "proposed", proposed: "Landon Hale", provenance: [{ kind: "file", label: "Purdue profile" }], by: "agent:box:t" }),
          field("mail", { label: "Email", bbox: [0.52, 0.306, 0.9, 0.332], state: "proposed", proposed: "landon@purdue.edu", provenance: [{ kind: "file", label: "Purdue profile" }], by: "agent:box:t" }),
          field("phone", { label: "Phone", bbox: [0.1, 0.376, 0.48, 0.402], state: "proposed", proposed: "(765) 494-0627", provenance: [{ kind: "file", label: "Purdue profile" }], by: "agent:box:t" }),
          field("head", { label: "Expected attendance", bbox: [0.52, 0.376, 0.9, 0.402], state: "proposed", proposed: "120 players, 400 guests", provenance: [{ kind: "file", label: "Run of show.docx" }], by: "agent:box:t" }),
          field("sig", { label: "Signature for Licensee", type: "signature", origin: "overlay", bbox: [0.1, 0.47, 0.56, 0.52], state: "needs-owner" }),
          field("date", { label: "Date", type: "date", origin: "overlay", bbox: [0.6, 0.47, 0.9, 0.52], state: "needs-owner" }),
        ],
      }),
    };
  }
  if (moment === "long") return { pages: guidePages(140), view: pdfView({ name: "Event planning guide 2027.pdf" }) };
  if (moment === "loading") return { pages: contractPages(), view: pdfView(), engine: never };
  if (moment === "locked") return { pages: contractPages(), view: pdfView(), engine: fakeEngine(fakeDoc([]), { password: "x" }) };
  if (moment === "moved") return { pages: contractPages(), view: pdfView({ missing: { asOf: Date.UTC(2026, 10, 16, 14, 12) } }) };
  return { pages: contractPages(), view: pdfView() };
}

export function PdfPreview({ moment = "reading" }: { moment?: PdfMoment }) {
  resetCanvasStore();
  const sessionId = `preview-pdf-${moment}`;
  const itemId = `${sessionId}-item`;
  const item: CanvasItem = { id: itemId, sessionId, workspaceId: "ws", kind: "pdf" as CanvasKind, title: moment === "long" ? "Event planning guide 2027.pdf" : "Ballroom contract.pdf", source: { at: "file", host: "local", path: "/work/contract.pdf" }, state: "open", position: 0, rev: 0, createdAt: 0, updatedAt: 0 };
  const { view, pages, engine } = setUp(moment);
  const host = fakePdfHost({ ...view, itemId });
  const doc = fakeDoc(pages);
  const deps = { host, engine: engine ?? fakeEngine(doc), width: 454, height: 492 };
  if (moment === "cite") {
    // Clause 3.2's own line, as the fixture lays it out: a citation an agent would write from pdf_extract's code.
    const line = pages[0].lines!.find((l) => l.text.startsWith("3.2"))!;
    deliverCite({ itemId, page: 1, bbox: [line.box[0] - 0.005, line.box[1] - 0.002, 0.6, line.box[3] + 0.002] });
  }
  if (moment === "find") {
    // After the column is up, as a person types: the first match scrolls into view.
    navOf(itemId).openFind();
    setTimeout(() => navOf(itemId).query("deposit"), 30);
  }
  const module = {
    Body: (props: CanvasBodyProps) => <PdfCanvas.Body {...(props as CanvasBodyProps<undefined>)} {...deps} />,
    Bar: (props: CanvasBodyProps) => <PdfCanvas.Bar {...(props as CanvasBodyProps<undefined>)} host={host} />,
  };
  const chunk = defineChunk(`preview-pdf-${moment}`, () => Promise.resolve(module));
  void chunk.load();
  const kinds: Record<CanvasKind, CanvasKindDef> = { ...CANVAS, pdf: { ...CANVAS.pdf, chunk: chunk as never } };
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
