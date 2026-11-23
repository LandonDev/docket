// A preview frame for `bun run ui:preview src/renderer/src/work/formats/PreviewFrame.preview.tsx#PreviewFrame --width 864 --shot`:
// the Preview surface (docs/DESIGN.md "Work editors: Preview") in each of its states, over a file of words drawn as
// paper in place of pdf.js and a source that answers at once.
import { contractPages, guidePages } from "../pdf/PdfCanvas.preview.fixtures";
import type { PdfEngine } from "../pdf/engine";
import { fakeDoc, fakeEngine } from "../pdf/testkit";
import { PageSwitchRow, Preview } from "./PreviewFrame";
import { MARGIN_PRESETS, type Drawn, type PageSetupModel, type PreviewBytes, type PreviewSource } from "./preview";

export type PreviewMoment = "word" | "folded" | "tiny" | "setup" | "long" | "drawing" | "failed" | "markdown" | "web" | "word-drew" | "pdf";

const FORMATS: PreviewSource["formats"] = [
  { id: "docx", label: "Word", ext: "docx", paged: true, verb: "Export" },
  { id: "pdf", label: "PDF", ext: "pdf", paged: true, verb: "Export" },
  { id: "md", label: "Markdown", ext: "md", paged: false, verb: "Export" },
  { id: "html", label: "Web page", ext: "html", paged: false, verb: "Export" },
  { id: "odt", label: "OpenDocument", ext: "odt", paged: true, verb: "Export" },
  { id: "rtf", label: "Rich Text", ext: "rtf", paged: true, verb: "Export" },
];

const bytes = (rev: string): PreviewBytes => ({ rev, size: 1, read: async () => new Uint8Array(1) });
const never = new Promise<Drawn>(() => undefined);

const MD = `# Spring LAN run of show

Saturday, April 10, 2027, North and South Ballrooms, Purdue Memorial Union

## Morning

| Time | What |
| --- | --- |
| 8:00 AM | Setup crew at the loading dock, power to every table |
| 8:30 AM | Check-in opens at the north doors |
| 9:00 AM | Doors open to guests[^1] |

Every table has two outlets from the floor drops. Nothing is taped to the walls.

[^1]: Not before 9:00 AM: the union's rule, contract clause 3.2.`;

const WEB = `<!doctype html><html><head><meta charset="utf-8"><title>Spring LAN run of show</title><style>body{font:16px/1.6 -apple-system,"Segoe UI","Liberation Sans",Arial,sans-serif;max-width:44rem;margin:2.5rem auto;padding:0 1.25rem}h1{font-size:2em;line-height:1.25}h2{font-size:1.5em}</style></head><body><h1>Spring LAN run of show</h1><p>Saturday, April 10, 2027, North and South Ballrooms, Purdue Memorial Union</p><h2>Morning</h2><p>Setup crew at the loading dock at 8:00 AM, power to every table. Check-in opens at the north doors at 8:30 AM and doors open to guests at 9:00 AM.</p><p>Every table has two outlets from the floor drops. Nothing is taped to the walls; ramps cover each cable that crosses a walkway.</p></body></html>`;

function setUp(moment: PreviewMoment): { source: PreviewSource; engine: PdfEngine; width: number; initial?: string; tight?: boolean; rows?: boolean } {
  const paper = fakeEngine(fakeDoc(moment === "long" ? guidePages(24) : contractPages()));
  const paged = (drops: string[], over: Partial<Extract<Drawn["picture"], { kind: "paged" }>> = {}): Drawn => ({ picture: { kind: "paged", pdf: bytes(moment), pages: moment === "long" ? 24 : 2, drawnBy: "libreoffice", ...over }, drops });
  const setup: PageSetupModel = { kind: "document", common: { paper: "Letter", orientation: "portrait", margins: { ...MARGIN_PRESETS.Normal }, header: true, footer: true }, columns: 1, differentFirst: false, set: async () => undefined };
  const source = (draw: (format: string) => Promise<Drawn>, over: Partial<PreviewSource> = {}): PreviewSource => ({ formats: FORMATS, draw, export: async (format) => ({ name: `Run of show.${format}` }), ...over });
  const LOSSES = ["3 suggestions go as tracked changes", "Aptos is drawn as Carlito here; Word will use Aptos"];
  switch (moment) {
    case "folded":
      return { source: source(async () => paged(LOSSES), { setup }), engine: paper, width: 502, tight: true, rows: true };
    case "tiny":
      return { source: source(async () => paged(LOSSES)), engine: paper, width: 400, tight: true };
    case "setup":
      return { source: source(async () => paged(LOSSES), { setup, office: async () => ({ app: "Word", state: "ready" }) }), engine: paper, width: 864, rows: true };
    case "long":
      return { source: source(async () => paged([])), engine: paper, width: 864 };
    case "drawing":
      return { source: source(() => never, { setup }), engine: paper, width: 864 };
    case "failed":
      return { source: source(() => Promise.reject(new Error("LibreOffice on tempcode-box did not answer"))), engine: paper, width: 864 };
    case "markdown":
      return { source: source(async () => ({ picture: { kind: "text", text: MD }, drops: ["2 comments stay behind", "Colours stay behind"] })), engine: paper, width: 864, initial: "md" };
    case "web":
      return { source: source(async () => ({ picture: { kind: "html", html: WEB }, drops: ["2 comments stay behind", "1 footnote moves to the end"] })), engine: paper, width: 864, initial: "html" };
    case "word-drew":
      return { source: source(async () => paged([], { drawnBy: "word" }), { office: async () => ({ app: "Word", state: "ready" }) }), engine: paper, width: 864 };
    case "pdf":
      return { source: source(async () => paged(["2 comments stay behind", "3 suggestions stay out until you accept them"], { drawnBy: "tempcode" })), engine: paper, width: 864, initial: "pdf" };
    default:
      return { source: source(async () => paged(LOSSES), { office: async () => ({ app: "Word", state: "ready" }) }), engine: paper, width: 864 };
  }
}

export function PreviewFrame({ moment = "word" }: { moment?: PreviewMoment }) {
  const { source, engine, width, initial, tight, rows } = setUp(moment);
  return (
    <div className="flex h-[620px] overflow-hidden rounded-xl border border-border" style={{ width }}>
      <div className="flex min-w-0 flex-1 flex-col">
        <Preview
          source={source}
          title="Spring LAN run of show"
          kind={`preview-${moment}`}
          {...(initial ? { initial } : {})}
          onClose={() => undefined}
          engine={engine}
          width={width}
          height={584}
          tight={tight ?? false}
          {...(rows ? { pageRows: <PageSwitchRow label="Different first page" checked={false} onChange={() => undefined} /> } : {})}
        />
      </div>
    </div>
  );
}
