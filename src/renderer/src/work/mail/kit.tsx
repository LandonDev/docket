import { Component, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { loadBytes, printInFrame, type MailFaceProps, type MailKit, type MailOrigin, type MailOriginLabel, type MailReference, type MailSectorMarkProps, type MailToastInput } from "work-kit/mail";
import { DropdownMenuItem } from "work-kit/ui/dropdown-menu";
import { AtSign } from "../../chrome/icons";
import { SectorDot } from "../../chrome/WorkspaceGlyph";
import { loadToast } from "../../components/ui/toaster";
import { useColorScheme } from "../../hooks/useColorScheme";
import { cn } from "../../lib/cn";
import { keyHint, modOrCtrl } from "../../lib/keys";
import { openUrl, saveDownload } from "../../lib/native";
import { sessionStore } from "../../lib/tcserver/store";
import { openWorkView, workOpenPort, workViewNow } from "../../lib/workSwitch";
import { shell } from "../../stores/shell";
import { currentActiveSession } from "../../stores/subscriptions";
import { undoLast } from "./client";
import { mailChip } from "./model";
import { EmptyState } from "../../surfaces/SurfaceSkeleton";

/**
 * TempCode's `MailKit` (work-kit/mail README, "The two seams"): its own
 * look and manners for the shared mail client. One for the window's life,
 * since the screens call its hooks in a fixed order. The data is
 * `client.ts`.
 */

// ── the kit ────────────────────────────────────────────────────────────

/**
 * The bar of a wait he can still stop (a send inside its undo time): full at
 * first, empty when the time is up. It runs once, on transform, for exactly
 * the time the toast stays.
 */
function Countdown({ ms }: { ms: number }) {
  const [running, setRunning] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setRunning(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <span aria-hidden className="ms-2 inline-block h-[3px] w-11 overflow-hidden rounded-full bg-muted align-middle">
      <span className="tc-mail-countdown block h-full origin-left bg-foreground motion-reduce:hidden" style={{ transform: running ? "scaleX(0)" : "scaleX(1)", "--tc-mail-countdown": `${ms}ms` } as CSSProperties} />
    </span>
  );
}

const toast = (input: string | MailToastInput): void => {
  const t = typeof input === "string" ? { message: input } : input;
  void loadToast().then((api) => {
    const options = {
      ...(t.id ? { id: t.id } : {}),
      ...(t.action ? { action: { label: t.action.label, onClick: t.action.run } } : {}),
      ...(t.lifetime !== undefined ? { duration: t.lifetime ?? Number.POSITIVE_INFINITY } : {}),
      // A wait ends by itself or by its action, never by a close of its own.
      ...(t.countdown ? { closeButton: false, dismissible: false } : {}),
    };
    const words =
      t.countdown && t.lifetime ? (
        <span className="inline-flex items-center">
          {t.message}
          <Countdown ms={t.lifetime} />
        </span>
      ) : (
        t.message
      );
    if (t.state === "error") api.error(words, options);
    else api(words, options);
  });
};

/** The thread that wrote a draft, by its title, with the way to it; a thread this window does not hold is named plainly. */
function threadLabel(origin: MailOrigin): MailOriginLabel | undefined {
  if (origin.app !== "tempcode") return undefined;
  const meta = sessionStore.metaOf(origin.threadId);
  if (!meta) return { label: "Drafted in a thread" };
  return { label: `Drafted in ${meta.title?.trim() || "a thread"}`, open: () => workOpenPort.get()?.(origin.threadId) };
}

/**
 * Who made a draft, in TempCode's words: the thread that wrote it, with a
 * way to open it. The Mail view and the mail item set the namer once they
 * can read threads; until then a draft with an origin is named plainly.
 */
let originNamer: ((origin: MailOrigin) => MailOriginLabel | undefined) | null = null;
export function nameOrigins(namer: typeof originNamer): void {
  originNamer = namer;
}

const initials = (name: string | undefined): string =>
  (name ?? "")
    .replace(/<[^>]*>|["']/g, "")
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");

// Initials are the 11px label step (docs/DESIGN.md "Type scale"), medium, at every size that holds two letters or one.
const FACE: Record<NonNullable<MailFaceProps["size"]>, string> = {
  line: "size-4 text-[11px] font-medium",
  chip: "size-[18px] text-[11px] font-medium",
  row: "size-6 text-[11px] font-medium",
  head: "size-7 text-[11px] font-medium",
};

/**
 * A person as initials on `muted` in a circle (docs/DESIGN.md, avatars):
 * 28px beside an open message's sender, 24px in a row, 18px in a recipient
 * chip and a fold row. The two small sizes hold one letter, which reads at
 * 11px; two would not.
 */
function Face({ name, size = "row", className }: MailFaceProps) {
  const letters = initials(name);
  return (
    <span
      aria-hidden
      className={cn(
        "inline-grid shrink-0 place-items-center rounded-full bg-muted text-muted-foreground outline-1 -outline-offset-1 outline-(--image-outline)",
        FACE[size],
        className,
      )}
    >
      {size === "chip" || size === "line" ? letters.slice(0, 1) : letters}
    </span>
  );
}

const SECTOR_NAMES: Record<string, string> = { cosmic: "Cosmic", hypixel: "Hypixel", purdue: "Purdue", ref: "Ref", unify: "Unify", life: "Life" };

/** A sector's mark with its name. TempCode's mail screens hold one sector, so a row's bare dot is drawn nowhere (docs/DESIGN.md: only where sectors mix). */
function SectorMark({ sector, label = true, className }: MailSectorMarkProps) {
  if (!label) return null;
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs text-muted-foreground", className)}>
      <SectorDot sector={sector} />
      {label ? SECTOR_NAMES[sector] ?? sector : null}
    </span>
  );
}

function useToday(): number {
  const midnight = (): number => new Date().setHours(0, 0, 0, 0);
  const [today, setToday] = useState(midnight);
  useEffect(() => {
    const next = new Date(today);
    next.setDate(next.getDate() + 1);
    const timer = window.setTimeout(() => setToday(midnight()), next.getTime() - Date.now() + 50);
    return () => window.clearTimeout(timer);
  }, [today]);
  return today;
}

/** Keys on the page, never while typing or while a dialog, a menu or a picker's list is open. */
function useKey(handler: (event: KeyboardEvent) => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || modOrCtrl(event) || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']")) return;
      // The mail list is a listbox of its own and always there: only a layer's list counts.
      if (document.querySelector("[role='dialog'], [role='menu'], [data-slot$='-content'] [role='listbox'], [role='listbox'][data-open]")) return;
      handler(event);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handler, enabled]);
}

const opened = async (file: { url: string }): Promise<"opened"> => {
  await openUrl(file.url);
  return "opened";
};

/** Save: the file's bytes, read from LifeOS's store, written into Downloads under its own name. */
const saved = async (file: { url: string; name: string }): Promise<"saved"> => {
  const blob = await loadBytes(file.url);
  await saveDownload(file.name, new Uint8Array(await blob.arrayBuffer()));
  return "saved";
};

class Boundary extends Component<{ className?: string; onNotFound?: () => void; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override componentDidCatch(error: unknown): void {
    if (/not found|does not exist/i.test(String(error))) this.props.onNotFound?.();
  }
  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className={this.props.className}>
        <EmptyState title="This mail could not be shown" />
      </div>
    );
  }
}

/**
 * "Mention in a thread", in a row's menu and a message's: the mail joins the
 * composer of the thread this window has open, as a chip, the same chip the
 * composer's own @ makes. With no thread open there is nothing to mention it
 * in, and the item is not drawn (Start thread, in the reader's More, makes one).
 */
function MentionItem({ reference, plain }: { reference: MailReference; plain?: boolean }) {
  const thread = currentActiveSession();
  if (!thread || thread.archived) return null;
  return (
    <DropdownMenuItem
      onClick={() => {
        // The chip store is the canvas chunk's; it is on the page by the time a thread is.
        void import("../canvas/chips").then(({ addContextChip }) => addContextChip(thread.id, mailChip(reference.id, reference.title)));
        toast({ message: `Mentioned in ${thread.title?.trim() || "the thread"}`, action: { label: "Open", run: () => workOpenPort.get()?.(thread.id) } });
      }}
    >
      {/* A row's right-click menu draws no icons; the reader's menus do. */}
      {plain ? null : <AtSign />}
      Mention in a thread
    </DropdownMenuItem>
  );
}

/** What a link in a mail may open outside the app: a web page, a mail address or a phone number, as the browser reads it. */
export function mailLink(href: string): boolean {
  try {
    return /^(https?|mailto|tel):$/.test(new URL(href).protocol);
  } catch {
    return false;
  }
}

export const tempcodeMailKit: MailKit = {
  toast,
  Face,
  SectorMark,
  keyHint: (chord) => keyHint(chord),
  useDark: () => useColorScheme() === "dark",
  useToday,
  useKey,
  onMailto: () => () => {},
  // Work-kit hands on only what a mail may open; the host checks again at its own door.
  openLink: (href) => {
    if (mailLink(href)) void openUrl(href);
  },
  openFile: opened,
  saveFile: saved,
  print: printInFrame,
  // A draft one of TempCode's threads made goes through the host's hold, which has no queue to pull a mail back from.
  holdsSend: (origin) => origin.app === "tempcode",
  // A draft a bot's key made carries no origin; TempCode names the threads it holds and nothing else.
  originLabel: ({ origin }) => (origin ? originNamer?.(origin) ?? threadLabel(origin) : undefined),
  reference: { props: () => ({}), MenuItem: MentionItem },
  undo: undoLast,
  // Mail's settings are under Settings, Work.
  openSettings: () => shell.openSettings("work"),
  // An invitation's event is in the workspace's Agenda.
  openEvent: () => {
    const at = workViewNow();
    if (at) openWorkView({ workspaceId: at.workspaceId, view: "agenda" });
  },
  fetchImage: async (url) => (await fetch(url)).blob(),
  Boundary,
};
