import type { DeckFacts, DeckOut, DeckOutAsk, DeckReach } from "@shared/contract-work-slides";
import { registry } from "../../../lib/connection";
import { fromBase64, saveFile } from "../../formats/model";
import { NotInReach, type CommonSetup, type DeckSetup, type Drawn, type PreviewBytes, type PreviewFormat, type PreviewSource } from "../../formats/preview";

/**
 * The deck's side of Preview (docs/agents/work-slides.md "Preview and export"): each way a deck goes out, drawn as
 * that file will be, by the host that holds the deck (`work.slides.preview`, read by rev with
 * `work.slides.previewRead`).
 *
 * - PowerPoint is the file itself, as LibreOffice draws it; "Check in PowerPoint" is PowerPoint's own PDF of it,
 *   only on his press.
 * - PDF is the file's slides, notes pages or handouts; Print is the same pages for paper.
 * - Pictures are each slide as a PNG or JPEG in a zip; a video of the slides is ffmpeg's, or PowerPoint's own.
 * - OpenDocument is drawn from the exported .odp itself.
 *
 * What a format leaves out is counted from the deck (`deckDrops`). Export writes the deck as it stands when he
 * presses: the host makes the file from the deck's bytes now, and answers the one it already made when they did
 * not change.
 */

export type DeckFormat = DeckOutAsk["format"];
export type DeckLayout = DeckSetup["layout"];

/** What he picked for each format, kept by the Body for as long as Preview is open. */
export interface DeckOptions {
  layout: DeckLayout;
  hidden: boolean;
  common: CommonSetup;
  picture: NonNullable<DeckOutAsk["picture"]>;
  video: Required<NonNullable<DeckOutAsk["video"]>>;
}

export const DECK_FORMATS: readonly (PreviewFormat & { id: DeckFormat })[] = [
  { id: "pptx", label: "PowerPoint", ext: "pptx", paged: true, verb: "Export", unit: "slide" },
  { id: "pdf", label: "PDF", ext: "pdf", paged: true, verb: "Export" },
  { id: "print", label: "Print", paged: true, verb: "Print…" },
  { id: "pics", label: "Pictures", ext: "zip", paged: false, verb: "Export" },
  { id: "video", label: "Video", ext: "mp4", paged: false, verb: "Export" },
  { id: "odp", label: "OpenDocument", ext: "odp", paged: true, verb: "Export", unit: "slide" },
];

/** A PDF of the slides counts slides; notes pages and handouts count pages. */
export const formatsFor = (layout: DeckLayout): PreviewFormat[] => DECK_FORMATS.map((f) => (f.id === "pdf" || f.id === "print" ? (layout === "slides" ? { ...f, unit: "slide" } : f) : f));

const count = (n: number, one: string, many: string): string | null => (n > 0 ? (n === 1 ? one : many.replace("{n}", n.toLocaleString("en-US"))) : null);

/**
 * What a format leaves out of this deck, one plain line each, counted from the file. The .pptx keeps everything;
 * the OpenDocument file is drawn from itself, so its picture shows what LibreOffice kept. A picture of a slide
 * (a PDF, paper, pictures, a video made here) shows the slide as it ends: effects do not play, a video on it is its
 * first frame, a sound is not there. PowerPoint's own video plays everything but the notes.
 */
export function deckDrops(format: DeckFormat, facts: DeckFacts, opts: Pick<DeckOptions, "layout"> & { videoBy?: "tempcode" | "powerpoint" }): string[] {
  const lines: (string | null)[] = [];
  const ours = format === "video" && opts.videoBy !== "powerpoint";
  const still = format === "pdf" || format === "print" || format === "pics" || ours;
  if (ours) lines.push("The video is silent");
  if (still) {
    const where = { pdf: "in a PDF", print: "on paper", pics: "in pictures", video: "in this video" }[format as "pdf" | "print" | "pics" | "video"];
    if (ours) {
      if (facts.animated > 0) lines.push("Animations do not play");
      if (facts.transitions > 0) lines.push("Transitions become fades");
    } else if (facts.animated > 0 && facts.transitions > 0) lines.push(`Animations and transitions do not play ${where}`);
    else if (facts.animated > 0) lines.push(`Animations do not play ${where}`);
    else if (facts.transitions > 0) lines.push(`Transitions do not play ${where}`);
    lines.push(count(facts.videos, "1 video becomes a picture", "{n} videos become pictures"));
    // A silent video has said so once already.
    if (!ours) lines.push(count(facts.sounds, "1 sound is left out", "{n} sounds are left out"));
  }
  const notesGo = format === "pics" || format === "video" || ((format === "pdf" || format === "print") && opts.layout !== "notes");
  if (notesGo) lines.push(count(facts.notes, "Speaker notes on 1 slide stay behind", "Speaker notes on {n} slides stay behind"));
  lines.push(count(facts.pending, "Suggestions on 1 slide stay out until you accept them", "Suggestions on {n} slides stay out until you accept them"));
  return lines.filter((line): line is string => line !== null);
}

/** The ask for a format: only what that format is made with. */
export function askOf(format: DeckFormat, opts: DeckOptions): DeckOutAsk {
  switch (format) {
    case "pdf":
    case "print":
      return { format, layout: opts.layout, hidden: opts.hidden, ...(opts.layout === "slides" ? {} : { page: opts.common }) };
    case "pics":
      return { format, hidden: opts.hidden, picture: opts.picture };
    case "video":
      return { format, hidden: opts.hidden, video: opts.video };
    default:
      return { format };
  }
}

type Request = <T>(env: string, method: string, params: unknown, opts?: { timeoutMs?: number }) => Promise<T>;
const linkRequest: Request = (env, method, params, opts) => registry.linkOf(env).request(method, params, opts);

export interface DeckPreviewDeps {
  env: string;
  itemId: string;
  options: DeckOptions;
  /** a change he made to the page set-up; the Body hands Preview a new source with it */
  setOptions(next: Partial<DeckOptions>): void;
  /** whether PowerPoint draws this deck from its host (`work.slides.reach`), asked once a Preview */
  reach(): Promise<DeckReach>;
  /** told the deck's counts after each draw: which rows mean anything (Hidden slides, for a deck with some) */
  onFacts?(facts: DeckFacts): void;
  request?: Request;
  save?(name: string, blob: Blob): void;
  print?(name: string, bytes: Uint8Array): Promise<void>;
}

/** The most one read answers (the wire's own cap for a range). */
export const READ_MAX = 4 * 1024 * 1024;
const MIME: Record<string, string> = { pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", pdf: "application/pdf", zip: "application/zip", mp4: "video/mp4", odp: "application/vnd.oasis.opendocument.presentation" };
const cancelled = (): DOMException => new DOMException("The draw was cancelled", "AbortError");

/** The deck's `PreviewSource`: one object for one file and one set of choices. */
export function deckPreviewSource(deps: DeckPreviewDeps): PreviewSource {
  const request = deps.request ?? linkRequest;
  const save = deps.save ?? saveFile;
  const print =
    deps.print ??
    (async (name: string, bytes: Uint8Array): Promise<void> => {
      const { printPdf } = await import("../../formats/printOut");
      await printPdf(name, bytes);
    });
  const opts = deps.options;

  const ask = (format: DeckFormat, office = false): Promise<DeckOut> =>
    request<DeckOut>(deps.env, "work.slides.preview", { itemId: deps.itemId, ...askOf(format, opts), ...(office ? { office: true } : {}) }, { timeoutMs: 30 * 60_000 });

  const bytesOf = (file: { rev: string; size: number }): PreviewBytes => ({
    rev: file.rev,
    size: file.size,
    read: async (offset, length) => {
      const got = await request<{ data: string }>(deps.env, "work.slides.previewRead", { itemId: deps.itemId, rev: file.rev, offset, length: Math.min(length, READ_MAX) }, { timeoutMs: 60_000 });
      return fromBase64(got.data);
    },
  });

  /** Every byte of a made file, a range at a time. */
  const whole = async (bytes: PreviewBytes): Promise<Uint8Array<ArrayBuffer>> => {
    const out = new Uint8Array(bytes.size);
    for (let offset = 0; offset < bytes.size; ) {
      const part = await bytes.read(offset, Math.min(READ_MAX, bytes.size - offset));
      if (part.length === 0) throw new Error("The file could not be read to its end");
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  };

  const drawn = (format: DeckFormat, out: DeckOut): Drawn => {
    deps.onFacts?.(out.facts);
    const drops = deckDrops(format, out.facts, { layout: opts.layout, videoBy: opts.video.by });
    if (format === "pics") return { picture: { kind: "files", files: out.thumbs ?? [] }, drops };
    if (format === "video") return { picture: { kind: "video", video: bytesOf(out.file), poster: out.video?.poster ?? "", seconds: out.video?.seconds ?? 0, size: `${out.video?.height ?? opts.video.height}p` }, drops };
    if (!out.pdf) throw new Error("There is no picture of this file");
    return { picture: { kind: "paged", pdf: bytesOf(out.pdf), pages: out.pdf.pages, drawnBy: out.drawnBy }, drops };
  };

  const setup: DeckSetup = {
    kind: "deck",
    common: opts.common,
    layout: opts.layout,
    hidden: opts.hidden,
    set: async (next) => deps.setOptions({ ...(next.common ? { common: next.common } : {}), ...(next.layout !== undefined ? { layout: next.layout } : {}), ...(next.hidden !== undefined ? { hidden: next.hidden } : {}) }),
  };

  // PowerPoint draws the deck's slides: the file's own pages, and no other format's.
  const office = async (format?: string): Promise<{ app: "PowerPoint"; state: DeckReach["pdf"] }> => ({
    app: "PowerPoint",
    state: format === "pptx" ? (await deps.reach().catch((): DeckReach => ({ pdf: "none", video: "none" }))).pdf : "none",
  });

  return {
    formats: formatsFor(opts.layout),
    setup,
    office,
    async draw(format, { by, signal }) {
      if (signal.aborted) throw cancelled();
      const f = format as DeckFormat;
      if (by === "office") {
        const { state } = await office(f);
        if (state !== "ready" && state !== "asleep") throw new NotInReach("PowerPoint", state);
      }
      const out = await ask(f, by === "office");
      if (signal.aborted) throw cancelled();
      return drawn(f, out);
    },
    async export(format) {
      const f = format as DeckFormat;
      // Made from the deck as it is now: the host answers the file it already made when the deck did not change.
      const out = await ask(f);
      const bytes = await whole(bytesOf(out.file));
      if (f === "print") {
        const name = out.file.name.replace(/\.pdf$/i, "");
        await print(name, bytes);
        return { name };
      }
      const ext = out.file.name.split(".").pop() ?? "";
      save(out.file.name, new Blob([bytes], { type: MIME[ext] ?? "application/octet-stream" }));
      return { name: out.file.name };
    },
  };
}
