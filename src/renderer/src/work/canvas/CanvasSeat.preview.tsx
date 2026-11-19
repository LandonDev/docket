// A preview frame for `bun run ui:preview src/renderer/src/work/canvas/CanvasSeat.preview.tsx#CanvasPreview --width 864`:
// the canvas pane beside a thread as the approved prototype draws it
// (.temp-code/prototypes/work-workspaces-2/canvas.html): three items as tabs,
// one alone, the thread folded, a loading item and a source that did not
// answer. A stand-in document kind feeds the frame the way a real kind will.
import { useEffect, type ReactNode } from "react";
import type { CanvasItem, CanvasKind, CanvasSource } from "@shared/work";
import { Composer } from "../../chrome/Composer";
import { composerFixtureBase } from "../../chrome/Composer.fixtures";
import { addContextChip, resetContextChips } from "./chips";
import { defineChunk } from "../../lib/lazyChunk";
import { workCanvasChunk } from "../../surfaces/chunks";
import { ChatFooter } from "../../surfaces/threads/chatSlots";
import { CanvasSeat } from "./CanvasSeat";
import type { CanvasBodyProps, CanvasKindDef } from "./kind";
import { CANVAS } from "./registry";
import { SelectionTools } from "./SelectionBar";
import { applyCanvasPush, setFolded } from "./store";

export type PreviewMoment = "three" | "one" | "folded" | "loading" | "unreachable" | "written" | "failed";

const source: CanvasSource = { at: "lifeos", table: "docs", id: "doc-1" };
const item = (id: string, kind: CanvasKind, title: string, position: number, sessionId: string): CanvasItem => ({
  id,
  sessionId,
  workspaceId: "ws",
  kind,
  title,
  source: kind === "document" ? source : { at: "thread" },
  state: "open",
  position,
  rev: 0,
  createdAt: 0,
  updatedAt: 0,
});

const ins = "rounded-sm bg-(--add-bg)";
const del = "rounded-sm bg-(--del-bg) text-(--soft-foreground) line-through decoration-destructive/70";

/** The prototype's run of show, with the agent's three changes tinted in place. */
function RunOfShow({ plain, ask }: { plain: boolean; ask: boolean }) {
  const change = (was: string, now: ReactNode, current = false): ReactNode =>
    plain ? (
      now
    ) : (
      <>
        {was ? <span className={del}>{was}</span> : null}
        {was ? " " : null}
        <span className={`${ins} ${current ? "outline-1 outline-offset-2 outline-border" : ""}`}>{now}</span>
      </>
    );
  const row = "relative mt-1 ps-[22px] before:absolute before:top-2.5 before:left-2 before:size-[5px] before:rounded-full before:bg-muted-foreground";
  return (
    <div className="px-8 pt-6 pb-12">
      <div className="mx-auto max-w-[672px] text-[15px] leading-6 select-text">
        <h1 className="text-lg leading-[26px] font-semibold tracking-[-0.01em]">Spring LAN run of show</h1>
        <div className="mt-1 text-xs text-muted-foreground">Spring LAN, edited 2:04 PM</div>
        <h2 className="mt-5 text-base leading-6 font-semibold tracking-[-0.01em]">Morning</h2>
        <div className={row}>
          <b className="font-semibold">{change("8:00 AM", "7:30 AM", true)}</b> Setup crew at the loading dock, power to every table
        </div>
        <div className={row}>
          {change(
            "",
            <>
              <b className="font-semibold">8:30 AM</b> Check-in opens at the north doors
            </>,
          )}
        </div>
        <div className={row}>
          <b className="font-semibold">9:00 AM</b> Doors open, not before: the union's rule
        </div>
        <h2 className="mt-5 text-base leading-6 font-semibold tracking-[-0.01em]">Bracket</h2>
        <div className="relative mt-1">
          {ask ? (
            <span className="relative">
              <span className="rounded-sm bg-(--sel-bg)">Pools run on 24 stations</span>
              {/* The floating bar is a popover in the app; drawn in place here, since a static page has no portal. */}
              <span className="absolute bottom-[calc(100%+6px)] left-0 z-10 flex rounded-xl bg-popover p-1 text-sm whitespace-nowrap shadow-overlay ring-1 ring-border">
                <SelectionTools
                  selection={{ chip: { kind: "selection", label: "Pools run on 24 stations", ref: source }, rect: new DOMRect() }}
                  onAsk={() => undefined}
                />
              </span>
            </span>
          ) : (
            "Pools run on 24 stations"
          )}{" "}
          until noon. The top two from each pool move to the stage bracket at 1:00 PM. {change("Lunch is on your own.", "Food trucks are on the east lot from 11:30.")}
        </div>
      </div>
    </div>
  );
}

const noop = async (): Promise<void> => undefined;

/** A stand-in document: it tells the frame what a real kind would. */
function bodyFor(moment: PreviewMoment) {
  return function Body({ shell }: CanvasBodyProps) {
    useEffect(() => {
      if (moment === "unreachable") {
        shell.statusLine({ tone: "failed", word: "LifeOS did not answer", detail: "Read only, as of 2:04 PM", action: { label: "Retry", run: () => undefined } });
        return;
      }
      shell.presence([
        { id: "sam", name: "Sam Ortiz" },
        { id: "dana", name: "Dana Lee" },
      ]);
      shell.mode({ value: moment === "written" ? "writes" : "suggests", set: () => undefined, note: "Others can edit this, so changes wait for you" });
      if (moment === "written") shell.written({ text: "Wrote 2 sections, 2:04 PM", undo: noop });
      else shell.review({ groups: [{ id: "g", label: "Venue for the spring LAN", by: "agent:box:t", count: 3 }], index: 0, count: 3, step: () => undefined, accept: noop, reject: noop });
    }, [shell]);
    return <RunOfShow plain={moment === "unreachable" || moment === "written"} ask={moment === "three"} />;
  };
}

const never = new Promise<never>(() => undefined);
// The composer's chip row is lazy: landed before the first render, so a static page draws it.
void workCanvasChunk.load();

function kindsFor(moment: PreviewMoment): Record<CanvasKind, CanvasKindDef> {
  // The real document kind, with no host to open it on: the tab row and the state line, as every failed open draws.
  if (moment === "failed") return CANVAS;
  const Body = bodyFor(moment);
  const chunk = defineChunk(`preview-${moment}`, () => (moment === "loading" ? never : Promise.resolve({ Body })));
  // Already landed, so the first render draws the body (a static page never sees the second).
  if (moment !== "loading") void chunk.load();
  return { ...CANVAS, document: { ...CANVAS.document, chunk } };
}

export function CanvasPreview({ moment = "three" }: { moment?: PreviewMoment }) {
  const sessionId = `preview-${moment}`;
  const many = moment === "three" || moment === "folded";
  applyCanvasPush({
    sessionId,
    items: [
      item(`${sessionId}-doc`, "document", "Spring LAN run of show", 0, sessionId),
      ...(many ? [item(`${sessionId}-sheet`, "sheet", "Nationals travel budget", 1, sessionId), item(`${sessionId}-pdf`, "pdf", "Ballroom contract", 2, sessionId)] : []),
    ],
    opened: `${sessionId}-doc`,
  });
  setFolded(sessionId, moment === "folded");
  resetContextChips();
  if (moment === "three") addContextChip(sessionId, { kind: "selection", label: "“Pools run on 24 stations”, Spring LAN run of show", ref: source, quote: "Pools run on 24 stations" });
  const kinds = kindsFor(moment);
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
