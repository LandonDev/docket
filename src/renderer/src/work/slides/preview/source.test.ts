import { describe, expect, it } from "vitest";
import type { DeckFacts, DeckOut, DeckReach } from "@shared/contract-work-slides";
import { NotInReach } from "../../formats/preview";
import { previewProblems } from "../../formats/previewContract";
import { defaultOptions } from "./DeckPreview";
import { askOf, deckDrops, deckPreviewSource, formatsFor, type DeckOptions } from "./source";

const NONE: DeckFacts = { slides: 12, hidden: 0, notes: 0, animated: 0, transitions: 0, videos: 0, sounds: 0, pending: 0 };
/** The lab's feature deck as the host counts it: builds on two slides, a fade and a push, a video and a sound, a hidden slide. */
const FEATURES: DeckFacts = { slides: 10, hidden: 1, notes: 7, animated: 2, transitions: 2, videos: 1, sounds: 1, pending: 0 };
const SLIDES = { layout: "slides" as const };

describe("what each format leaves out, counted from the deck", () => {
  it("says nothing for the file itself or a deck that loses nothing", () => {
    expect(deckDrops("pptx", FEATURES, SLIDES)).toEqual([]);
    expect(deckDrops("odp", FEATURES, SLIDES)).toEqual([]);
    for (const f of ["pdf", "print", "pics"] as const) expect(deckDrops(f, NONE, SLIDES)).toEqual([]);
  });

  it("a PDF, paper and pictures show each slide as it ends: effects, a video's motion, sounds and notes stay behind", () => {
    expect(deckDrops("pdf", FEATURES, SLIDES)).toEqual(["Animations and transitions do not play in a PDF", "1 video becomes a picture", "1 sound is left out", "Speaker notes on 7 slides stay behind"]);
    expect(deckDrops("print", { ...NONE, animated: 3 }, SLIDES)).toEqual(["Animations do not play on paper"]);
    expect(deckDrops("pics", { ...NONE, transitions: 2, videos: 2 }, SLIDES)).toEqual(["Transitions do not play in pictures", "2 videos become pictures"]);
    // Notes pages carry the notes; handouts do not.
    expect(deckDrops("pdf", FEATURES, { layout: "notes" })).not.toContain("Speaker notes on 7 slides stay behind");
    expect(deckDrops("pdf", FEATURES, { layout: { handouts: 3 } })).toContain("Speaker notes on 7 slides stay behind");
  });

  it("the video made here says it is silent first, and once", () => {
    expect(deckDrops("video", NONE, SLIDES)).toEqual(["The video is silent"]);
    expect(deckDrops("video", FEATURES, SLIDES)).toEqual(["The video is silent", "Animations do not play", "Transitions become fades", "1 video becomes a picture", "Speaker notes on 7 slides stay behind"]);
    // PowerPoint's own plays everything; only the notes stay behind.
    expect(deckDrops("video", FEATURES, { ...SLIDES, videoBy: "powerpoint" })).toEqual(["Speaker notes on 7 slides stay behind"]);
  });

  it("names the suggestions that wait, in every format, since the file holds none of them", () => {
    expect(deckDrops("pptx", { ...NONE, pending: 1 }, SLIDES)).toEqual(["Suggestions on 1 slide stay out until you accept them"]);
    expect(deckDrops("video", { ...NONE, pending: 3 }, SLIDES).at(-1)).toBe("Suggestions on 3 slides stay out until you accept them");
    for (const f of ["pptx", "pdf", "print", "pics", "video", "odp"] as const) for (const line of deckDrops(f, { ...FEATURES, pending: 2 }, SLIDES)) expect(line).not.toMatch(/not supported|\n|\.$/);
  });
});

describe("the ask", () => {
  it("carries only what a format is made with", () => {
    const o = defaultOptions("en-US");
    expect(askOf("pptx", o)).toEqual({ format: "pptx" });
    expect(askOf("pdf", o)).toEqual({ format: "pdf", layout: "slides", hidden: false });
    expect(askOf("print", { ...o, layout: { handouts: 6 } })).toEqual({ format: "print", layout: { handouts: 6 }, hidden: false, page: o.common });
    expect(askOf("pics", o)).toEqual({ format: "pics", hidden: false, picture: { type: "png", width: 1920 } });
    expect(askOf("video", o)).toEqual({ format: "video", hidden: false, video: { seconds: 5, height: 1080, by: "tempcode" } });
    expect(o.common.paper).toBe("Letter");
    expect(defaultOptions("en-GB").common.paper).toBe("A4");
    // A PDF of the slides counts slides; handouts count pages.
    expect(formatsFor("slides").find((f) => f.id === "pdf")!.unit).toBe("slide");
    expect(formatsFor("notes").find((f) => f.id === "pdf")!.unit).toBeUndefined();
  });
});

// ── the source against the contract, on a host that answers as the real one does ──

const PDF = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
const MP4 = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]);
function fakeHost(reach: DeckReach = { pdf: "asleep", video: "none" }) {
  const asks: Array<Record<string, unknown>> = [];
  const files = new Map<string, Uint8Array>();
  const out = (ask: Record<string, unknown>): DeckOut => {
    const f = ask.format as string;
    const rev = `${f}${ask.office ? "-pp" : ""}`.padEnd(32, "0");
    const pdf = { rev, size: PDF.length, pages: ask.layout && ask.layout !== "slides" ? 2 : 12 };
    files.set(rev, f === "video" ? MP4 : PDF);
    const facts = FEATURES;
    if (f === "pics") return { file: { rev, size: PDF.length, name: "Talk.zip" }, thumbs: [{ name: "Slide 01.png", thumb: "data:image/jpeg;base64,AA" }], drawnBy: "tempcode", facts };
    if (f === "video") return { file: { rev, size: MP4.length, name: "Talk.mp4" }, video: { seconds: 60, poster: "data:image/jpeg;base64,AA", height: 1080 }, drawnBy: "tempcode", facts };
    const name = { pptx: "Talk.pptx", odp: "Talk.odp" }[f] ?? "Talk.pdf";
    return { file: { rev, size: PDF.length, name }, pdf, drawnBy: ask.office ? "powerpoint" : f === "pptx" || f === "odp" ? "libreoffice" : "tempcode", facts };
  };
  const request = async <T,>(_env: string, method: string, params: unknown): Promise<T> => {
    const p = params as Record<string, unknown>;
    if (method === "work.slides.preview") return (asks.push(p), out(p)) as T;
    if (method === "work.slides.previewRead") {
      const bytes = files.get(p.rev as string);
      if (!bytes) throw new Error("That file is gone: draw it again.");
      const offset = p.offset as number;
      return { data: btoa(String.fromCharCode(...bytes.subarray(offset, offset + (p.length as number)))) } as T;
    }
    throw new Error(`no ${method}`);
  };
  return { asks, request, reach: async () => reach };
}

describe("the deck's PreviewSource", () => {
  const sourceOn = (host: ReturnType<typeof fakeHost>, options: DeckOptions = defaultOptions("en-US"), extra: Partial<Parameters<typeof deckPreviewSource>[0]> = {}) =>
    deckPreviewSource({ env: "env_box", itemId: "item1", options, setOptions: () => undefined, reach: host.reach, request: host.request, ...extra });

  it("keeps the Preview contract, every format drawn and exported, with PowerPoint's own picture of the file on his press", async () => {
    const host = fakeHost();
    const saved: string[] = [];
    const printed: string[] = [];
    const source = sourceOn(host, defaultOptions("en-US"), { save: (name) => void saved.push(name), print: async (name) => void printed.push(name) });
    expect(await previewProblems(source, { exports: true })).toEqual([]);
    expect(saved).toEqual(["Talk.pptx", "Talk.pdf", "Talk.zip", "Talk.mp4", "Talk.odp"]);
    // Print hands the PDF to this computer to print, by the deck's name.
    expect(printed).toEqual(["Talk"]);
    expect(host.asks.filter((a) => a.office)).toEqual([{ itemId: "item1", format: "pptx", office: true }]);
    // The contract holds with PowerPoint out of reach too.
    expect(await previewProblems(sourceOn(fakeHost({ pdf: "none", video: "none" })))).toEqual([]);
  });

  it("offers PowerPoint's picture for the file alone, and draws pictures and the video as files", async () => {
    const host = fakeHost({ pdf: "ready", video: "ready" });
    const source = sourceOn(host);
    expect(await source.office!("pptx")).toEqual({ app: "PowerPoint", state: "ready" });
    expect(await source.office!("pdf")).toEqual({ app: "PowerPoint", state: "none" });
    await expect(source.draw("pdf", { by: "office", signal: new AbortController().signal })).rejects.toBeInstanceOf(NotInReach);
    const pics = await source.draw("pics", { signal: new AbortController().signal });
    expect(pics.picture).toEqual({ kind: "files", files: [{ name: "Slide 01.png", thumb: "data:image/jpeg;base64,AA" }] });
    const video = await source.draw("video", { signal: new AbortController().signal });
    expect(video.picture).toMatchObject({ kind: "video", seconds: 60, size: "1080p" });
    expect(video.drops[0]).toBe("The video is silent");
  });

  it("tells the Body the deck's counts and hands a change of the page set-up back to it", async () => {
    const host = fakeHost();
    const facts: DeckFacts[] = [];
    const changes: unknown[] = [];
    const source = sourceOn(host, defaultOptions("en-US"), { onFacts: (f) => void facts.push(f), setOptions: (next) => void changes.push(next) });
    await source.draw("pdf", { signal: new AbortController().signal });
    expect(facts).toEqual([FEATURES]);
    expect(source.setup).toMatchObject({ kind: "deck", layout: "slides", hidden: false });
    await source.setup!.set({ layout: "notes" });
    expect(changes).toEqual([{ layout: "notes" }]);
  });
});
