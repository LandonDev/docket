import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import type { ActKind } from "@shared/work";
import { BusyLabel, Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { Globe, Outbox, Plug, SquareMousePointer } from "../../chrome/icons";
import { cn } from "../../lib/cn";
import { registerToastAnchor } from "../../lib/toastAnchor";
import { kindHeading } from "../acts/kindRows";
import { Calendar, Chat, File, Link, Mail, Share, Task, Video } from "../icons";
import { EDITABLE, pastOf, payloadView } from "./model";
import { fetchItem, loadHost, type HostItem } from "./store";

/**
 * The Outbox's small shared parts (docs/DESIGN.md "The Outbox"): the words a
 * row says, the kind's glyph, the verb bar, the bones, a host's Retry and a
 * computer act's kept picture. Today's held rows and Away's list draw a held
 * item with these too.
 */

/** "Send to Dana Lee: Re: budget" → the act and what it is about. */
export function splitSummary(summary: string): { act: string; about: string | null } {
  const at = summary.indexOf(": ");
  return at > 0 ? { act: summary.slice(0, at), about: summary.slice(at + 2) } : { act: summary, about: null };
}

/** An agent's change to a shared file: it sends nothing, so its words are the change's own. */
export const changeKind = (kind: string): boolean => kind === "office.edit" || kind === "google.edit";

/**
 * A list row's act and what it is about. Most acts split their summary at its colon; a Google share's summary
 * ("Share Budget Q3 final.xlsx with dana@… (can edit)") has none, so a long file name would cut the person off: its
 * act is who and how ("Share with dana@purdue.edu (can edit)") and the file its line. The detail keeps its own heading.
 */
export function rowWords(item: Pick<HostItem, "kind" | "summary" | "verb" | "payload"> & { state?: HostItem["state"] }): { act: string; about: string | null } {
  // An agent's change to a shared file: the file leads ("Change Brief.docx"), so a long verb never cuts its name off,
  // and the line is the change, read after the file's own name (which may hold ": " itself), its count first.
  const changed = changeKind(item.kind) ? kindHeading(item.kind, item.payload, item.state === "sent") : null;
  if (changed) {
    const p = (item.payload ?? {}) as { name?: unknown; edits?: unknown };
    const lead = typeof p.name === "string" ? item.summary.indexOf(` in ${p.name}: `) : -1;
    const about = lead >= 0 ? item.summary.slice(lead + ` in ${p.name}: `.length) : splitSummary(item.summary).about;
    const n = Array.isArray(p.edits) ? p.edits.length : 1;
    // Several changes: their count leads, and the first one's own reach ("3 boxes, ") is left to the detail.
    return { act: changed, about: about && n > 1 ? `${n} changes: ${about.replace(/ and \d+ more$/, "").replace(/^\d+ (boxes|places), /, "")}` : about };
  }
  if (item.kind === "share.google") {
    const p = (item.payload ?? {}) as { email?: unknown; name?: unknown };
    const role = /\(([^)]*)\)\s*$/.exec(item.summary)?.[1];
    if (typeof p.email === "string" && typeof p.name === "string") return { act: `${item.verb} with ${p.email}${role ? ` (${role})` : ""}`, about: p.name };
  }
  return splitSummary(item.summary);
}

/** The title an item's detail reads: its kind's own heading, else the act, in the past once it went. */
export function itemTitle(item: Pick<HostItem, "kind" | "summary" | "verb" | "payload" | "state">, went: boolean): string {
  const { act } = splitSummary(item.summary);
  return kindHeading(item.kind, item.payload, went) ?? (went && act.startsWith(item.verb) ? `${pastOf(item.verb, item.kind)}${act.slice(item.verb.length)}` : act);
}

const KIND_GLYPH: Record<ActKind, ComponentType<{ className?: string }>> = {
  "mail.send": Mail,
  "office.mail.send": Mail,
  "calendar.op": Calendar,
  "office.calendar.op": Calendar,
  "office.edit": File,
  "google.edit": File,
  "file.act": File,
  "addon.call": Plug,
  "computer.act": SquareMousePointer,
  "portal.submit": Globe,
  "chat.reply": Chat,
  "teams.post": Chat,
  "share.guestLink": Link,
  "share.google": Share,
  "form.publish": Task,
  "msform.make": Task,
  "msform.publish": Task,
  "frameio.post": Video,
};
/** A held act's glyph by its kind, muted (Today's held rows lead with it too). */
export function KindGlyph({ kind, className }: { kind: ActKind; className?: string }) {
  const Glyph = KIND_GLYPH[kind] ?? Outbox;
  return <Glyph className={cn("size-3.5 text-muted-foreground", className)} />;
}

/** States a press may take an item from. */
export const pressable = (item: Pick<HostItem, "state">): boolean => item.state === "held" || item.state === "live" || item.state === "failed";

/**
 * Whether Edit has anything to offer: a field a person may change, or a body not drawn from html alone. An act read
 * from a live screen is carried out as it was read, so the host refuses any change to it.
 */
export function canEdit(item: Pick<HostItem, "payload" | "state" | "kind">): boolean {
  if (item.state === "live" || !EDITABLE.includes(item.kind)) return false;
  const view = payloadView(item.payload);
  return view.fields.some((f) => f.edit !== null) || (view.body !== null && !view.body.readOnly);
}

/** A list press's past verb: the acts' own when they share one ("Posted 2"), else "Sent"; never the first item's alone. */
export function batchVerb(items: readonly (Pick<HostItem, "verb"> & { kind?: string })[]): string {
  const verbs = new Set(items.map((i) => i.verb.split(" ")[0]!));
  const kinds = new Set(items.map((i) => i.kind));
  return verbs.size === 1 ? pastOf([...verbs][0]!, kinds.size === 1 ? [...kinds][0] : undefined) : "Sent";
}

/** Where he looks to see whether a send that may have gone went. */
export const checkWords = (item: Pick<HostItem, "kind">): string => (item.kind === "mail.send" || item.kind === "office.mail.send" ? "Check Sent first" : "Check whether it went first");

/**
 * The detail's foot: the hairline across the pane, its verbs in the detail's own column so they line up with the
 * text. The toast stack sits above it (`registerToastAnchor`): a notice that stays never covers Send.
 */
export function VerbBar({ children }: { children: ReactNode }) {
  return (
    // Not inside a sheet (Today's held item): a sheet lies over the toasts, and a stack seated there would show cut by its edge.
    <div ref={(el) => (el && !el.closest("[role=dialog]") ? registerToastAnchor(el) : undefined)} data-outbox-verbs className="shrink-0 border-t border-border">
      <div className="mx-auto flex min-h-14 w-full max-w-[688px] items-center gap-2 px-8 py-3 @max-[40rem]/outbox:px-4">{children}</div>
    </div>
  );
}

/** The detail's scrolling column: 688px at most, 24px over the head, 32px at the sides and foot (16px narrow). */
export function DetailColumn({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-none">
      <div className={cn("mx-auto flex w-full max-w-[688px] flex-col px-8 pt-6 pb-8 @max-[40rem]/outbox:px-4 @max-[40rem]/outbox:pt-3", className)}>{children}</div>
    </div>
  );
}

/** While the Outbox first loads: the detail's facts, title, sentence and the thing's block, in its column. */
export function DetailSkeleton() {
  return (
    <div role="status" aria-label="Loading the item" aria-busy className="mx-auto flex w-full max-w-[688px] flex-col px-8 pt-6">
      <span className="flex h-7 items-center">
        <Skeleton className="h-3 w-40" />
      </span>
      <span className="mt-1 flex h-6 items-center">
        <Skeleton className="h-4 w-64 max-w-full" />
      </span>
      <span className="mt-2 flex h-[22px] items-center">
        <Skeleton className="h-3.5 w-[80%]" />
      </span>
      <Skeleton className="mt-5 h-40 w-full rounded-lg" />
    </div>
  );
}

/** A host's error row's Retry: that host alone asked again, busy and off while it reads; the row goes once it answers. */
export function HostRetry({ environmentId }: { environmentId: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="xs"
      variant="ghost"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void loadHost(environmentId).finally(() => setBusy(false));
      }}
    >
      <BusyLabel busy={busy} label="Retry" />
    </Button>
  );
}

/**
 * A computer act's kept picture: the window as it was read, in the held detail (what his press approves) and in its
 * Done record. The list leaves the picture's bytes out, so the whole act is read for it; an act that kept none draws
 * nothing, and a read that failed says so with Retry.
 */
export type Picture = { kept: { width?: number; height?: number } | null | undefined; src: string | null | undefined | "failed"; loaded: boolean; retry(): void; onLoad(): void; onError(): void };

/** The kept picture of a computer act, read whole: undefined while it comes, "failed" when the host did not answer, null when none was kept. */
export function usePicture(item: HostItem): Picture {
  const kept = item.kind === "computer.act" ? (item.payload as { picture?: { width?: number; height?: number } | null } | null)?.picture : null;
  const key = kept ? JSON.stringify(item.ref) : null;
  const [src, setSrc] = useState<string | null | undefined | "failed">(undefined);
  const [loaded, setLoaded] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!key) return;
    let live = true;
    setSrc(undefined);
    setLoaded(false);
    fetchItem(item.environmentId, item.ref).then(
      (whole) => {
        const picture = (whole.payload as { picture?: { data?: string; mimeType?: string } | null } | null)?.picture;
        // A picture the act kept but whose bytes did not come is a failure, never "none kept".
        if (live) setSrc(picture?.data ? `data:${picture.mimeType ?? "image/jpeg"};base64,${picture.data}` : "failed");
      },
      () => live && setSrc("failed"),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read again only for another act or a Retry
  }, [key, attempt]);
  return { kept, src: key ? src : null, loaded, retry: () => setAttempt((n) => n + 1), onLoad: () => setLoaded(true), onError: () => setSrc("failed") };
}

/** Whether what his press approves is all on screen: a computer act's kept picture has drawn, or none was kept. */
export const pictureShown = (p: Picture): boolean => p.src === null || (typeof p.src === "string" && p.src !== "failed" && p.loaded);

export function KeptPicture({ item, picture }: { item: HostItem; picture: Picture }) {
  const { kept, src } = picture;
  if (!kept || src === null) return null;
  const shape = kept.width && kept.height ? `${kept.width} / ${kept.height}` : "16 / 10";
  if (src === undefined) return <Skeleton className="w-full rounded-lg" style={{ aspectRatio: shape }} />;
  if (src === "failed")
    return (
      <p className="flex items-baseline gap-2 text-[13px] leading-5">
        <span className="text-destructive">The picture did not load</span>
        <Button variant="ghost" size="xs" onClick={picture.retry}>
          Retry
        </Button>
      </p>
    );
  return <img src={src} onLoad={picture.onLoad} onError={picture.onError} alt={`The window as it was read, ${item.summary}`} draggable={false} className="h-auto w-full rounded-lg outline outline-1 -outline-offset-1 outline-image-outline" style={{ aspectRatio: shape }} />;
}
