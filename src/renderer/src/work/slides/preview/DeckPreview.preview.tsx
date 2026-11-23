// A preview frame for `bun run ui:preview src/renderer/src/work/slides/preview/DeckPreview.preview.tsx#DeckPreviewPreview`:
// the deck's Preview (docs/agents/work-slides.md "Preview and export") in each format, over the prototype's sponsor
// deck drawn as slides in place of pdf.js and a host that answers at once.
import { useMemo, useState } from "react";
import type { DeckFacts, DeckOut, DeckReach } from "@shared/contract-work-slides";
import type { PdfEngine } from "../../pdf/engine";
import { Preview } from "../../formats/PreviewFrame";
import { SPONSOR, sponsorDoc } from "../SlidesCanvas.preview.fixtures";
import { handoutsDoc, sponsorThumb } from "./DeckPreview.preview.fixtures";
import { deckRows, defaultOptions } from "./DeckPreview";
import { deckPreviewSource, type DeckLayout, type DeckOptions } from "./source";

export type DeckMoment = "pptx" | "pdf" | "handouts" | "print" | "pics" | "video" | "odp";

/** The sponsor deck as the host counts it: a build, a fade, a video, notes on five slides, a hidden slide, two suggestions waiting. */
const FACTS: DeckFacts = { slides: 8, hidden: 1, notes: 5, animated: 1, transitions: 1, videos: 1, sounds: 0, pending: 2 };

/** Each render's bytes are its own name: the engine opens the slides or the sheet of handouts by it. */
const engine: PdfEngine = {
  async open(file) {
    const name = new TextDecoder().decode(await file.read(0, file.size));
    return name.startsWith("paper") ? handoutsDoc() : sponsorDoc(SPONSOR.map((_, i) => i + 1));
  },
};

function host(reach: DeckReach) {
  return async <T,>(_env: string, method: string, params: unknown): Promise<T> => {
    const p = params as { format?: string; layout?: DeckLayout; rev?: string };
    if (method === "work.slides.previewRead") return { data: btoa(p.rev ?? "") } as T;
    if (method === "work.slides.reach") return reach as T;
    const paper = p.layout !== undefined && p.layout !== "slides";
    const rev = paper ? "paper" : "slides";
    const thumbs = SPONSOR.map((_, i) => ({ name: `Slide ${String(i + 1).padStart(2, "0")}.png`, thumb: sponsorThumb(i + 1) }));
    const out: DeckOut =
      p.format === "pics"
        ? { file: { rev, size: rev.length, name: "Sponsor deck.zip" }, thumbs, drawnBy: "tempcode", facts: FACTS }
        : p.format === "video"
          ? { file: { rev, size: rev.length, name: "Sponsor deck.mp4" }, video: { seconds: 40, poster: sponsorThumb(1), height: 1080 }, drawnBy: "tempcode", facts: FACTS }
          : { file: { rev, size: rev.length, name: "Sponsor deck.pdf" }, pdf: { rev, size: rev.length, pages: paper ? 2 : 8 }, drawnBy: p.format === "pptx" || p.format === "odp" ? "libreoffice" : "tempcode", facts: FACTS };
    return out as T;
  };
}

export function DeckPreviewPreview({ moment = "pptx", width = 1200 }: { moment?: DeckMoment; width?: number }) {
  const [options, setOptionsState] = useState<DeckOptions>(() => ({ ...defaultOptions("en-US"), ...(moment === "handouts" ? { layout: { handouts: 6 } as DeckLayout } : {}) }));
  const set = (next: Partial<DeckOptions>): void => setOptionsState((o) => ({ ...o, ...next }));
  const reach: DeckReach = { pdf: "ready", video: "asleep" };
  const request = useMemo(() => host(reach), []); // eslint-disable-line react-hooks/exhaustive-deps
  const source = useMemo(() => deckPreviewSource({ env: "e", itemId: "deck", options, setOptions: set, reach: async () => reach, request }), [options]); // eslint-disable-line react-hooks/exhaustive-deps
  const initial = moment === "handouts" ? "pdf" : moment;
  return (
    <div className="flex h-[640px] overflow-hidden rounded-xl border border-border" style={{ width }}>
      <div className="flex min-w-0 flex-1 flex-col">
        <Preview
          source={source}
          title="Sponsor deck"
          kind={`deck-preview-${moment}`}
          initial={initial}
          onClose={() => undefined}
          engine={engine}
          width={width}
          height={604}
          tight={width < 700}
          rowsFor={(format) => deckRows(format, { options, set, hidden: FACTS.hidden, aspect: 16 / 9, reach })}
        />
      </div>
    </div>
  );
}
