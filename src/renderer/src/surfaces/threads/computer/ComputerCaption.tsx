import { useRef, useState, type ReactNode } from "react";
import { BusyLabel, Button } from "@renderer/components/ui/button";
import { Kbd } from "@renderer/components/ui/kbd";
import { loadToast } from "@renderer/components/ui/toaster";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { TruncateTip } from "@renderer/components/tip";
import { Keyboard, Square } from "../../../chrome/icons";
import { RowsMenu } from "../../../chrome/menuRows";
import { pressKeys } from "../../../lib/computerVideo";
import { canTakeOver, handBack, takeOver, type ComputerTile } from "../../../lib/computers";
import { stopComputer } from "../../../lib/computerSessions";
import { keyHint } from "../../../lib/keys";
import { LEAVE_CHORD } from "../../../lib/video/videoInput";
import { Facts } from "../../settings/hosts/Facts";

/**
 * The row under a computer's picture where it is the one he watches: the
 * Computers page's stage and the full window (docs/DESIGN.md "Computers").
 * The thread's title over one line, and the controls at its end, always
 * shown.
 */

/** What a computer says first: that he drives, a card's question, else the step's words. */
export const tileLine = (tile: ComputerTile): string | null => (tile.driving ? "You are driving" : (tile.entry.row.asking?.line ?? tile.doing));

/**
 * Take over (where the computer takes input from its picture) and Stop; while he drives, Hand back alone, the one
 * primary, with the chord that leaves the picture. `onTookOver` runs as the press begins, so the picture can take the
 * keyboard as soon as it is his.
 */
export function StageControls({ tile, onTookOver }: { tile: ComputerTile; onTookOver?: () => void }) {
  const [busy, setBusy] = useState<"take" | "back" | "stop" | null>(null);
  const pressing = useRef(false);
  const press = (which: "take" | "back" | "stop", run: () => Promise<unknown>, failed: string): void => {
    if (pressing.current) return;
    pressing.current = true;
    setBusy(which);
    void run()
      .catch(() => loadToast().then((toast) => toast.error(failed, { description: tile.title })))
      .finally(() => {
        pressing.current = false;
        setBusy(null);
      });
  };
  if (tile.driving)
    return (
      <span data-slot="computer-controls" className="flex shrink-0 items-center gap-1">
        {tile.computer.startsWith("vm:") ? <KeysMenu tile={tile} /> : null}
        <Button size="sm" data-hand-back disabled={!!busy} onClick={() => press("back", () => handBack(tile), "Couldn't hand it back")}>
          <BusyLabel busy={busy === "back"} label="Hand back" />
          <Kbd size="sm" aria-hidden="true" className="border-transparent bg-transparent text-primary-foreground">
            {keyHint(LEAVE_CHORD)}
          </Kbd>
        </Button>
      </span>
    );
  return (
    <span data-slot="computer-controls" className="flex shrink-0 items-center gap-1">
      {canTakeOver(tile) ? (
        <Button
          variant="secondary"
          size="sm"
          disabled={!!busy}
          onClick={() =>
            press(
              "take",
              async () => {
                onTookOver?.();
                await takeOver(tile);
              },
              "Couldn't take over",
            )
          }
        >
          <BusyLabel busy={busy === "take"} label="Take over" />
        </Button>
      ) : null}
      {/* an idle page has nothing running to stop */}
      {tile.idle ? null : (
        <Tooltip>
          <TooltipTrigger
            render={<Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-foreground" aria-label={`Stop ${tile.title}`} disabled={!!busy} onClick={() => press("stop", () => stopComputer(tile.entry), "Couldn't stop it")} />}
          >
            <Square className="size-2.5 fill-current" />
          </TooltipTrigger>
          <TooltipContent>Stop</TooltipContent>
        </Tooltip>
      )}
    </span>
  );
}

/** The keys a person's own keyboard cannot send into the Windows VM from here, by HID usage code: pressed in order, let go in reverse. */
export const VM_KEYS: readonly { id: string; label: string; keys: readonly number[] }[] = [
  { id: "windows", label: "Windows key", keys: [227] },
  { id: "ctrl-alt-del", label: "Ctrl+Alt+Del", keys: [224, 226, 76] },
  { id: "alt-tab", label: "Alt+Tab", keys: [226, 43] },
];

/** The picture he drives nearest to an element of its caption: the stage's, the full window's, the pop-out's. */
export function pictureNear(el: Element | null): HTMLElement | null {
  for (let n = el?.parentElement ?? null; n; n = n.parentElement) {
    const picture = n.querySelector<HTMLElement>('[role="application"]');
    if (picture) return picture;
  }
  return null;
}

/**
 * While he drives the Windows VM: one quiet button with the keys his own keyboard would keep for itself. A pick gives
 * the keyboard back to the picture, so the next keys he types go to the VM (Start opened by the Windows key takes them).
 */
function KeysMenu({ tile }: { tile: ComputerTile }) {
  const button = useRef<HTMLButtonElement>(null);
  const back = { get current() { return pictureNear(button.current) ?? button.current; } };
  return (
    <RowsMenu
      finalFocus={back}
      label="Keys"
      align="end"
      side="top"
      tip={{ label: "Keys" }}
      rows={VM_KEYS.map((k) => ({ kind: "item" as const, id: k.id, label: k.label }))}
      onPick={(id) => {
        const chord = VM_KEYS.find((k) => k.id === id);
        if (!chord || !tile.entry.previewHost || !tile.entry.previewKey) return;
        void pressKeys(tile.entry.previewHost, tile.entry.previewKey, chord.keys).then((sent) => {
          if (!sent) void loadToast().then((toast) => toast.error("Couldn't send the keys", { description: tile.title }));
        });
      }}
      trigger={
        <Button ref={button} variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-foreground" aria-label="Keys">
          <Keyboard className="size-4" />
        </Button>
      }
    />
  );
}

/** A quiet icon button with a tip, for the caption's views (Full window, Pop out, back). */
export function ViewButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-foreground" aria-label={label} onClick={onClick} />}>{children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export interface CaptionProps {
  tile: ComputerTile;
  /** a press on the title: the thread */
  onOpenSession: (threadId: string, host: string) => void;
  /** where it runs, or null where the picture already names the machine */
  where: string | null;
  onTookOver?: () => void;
  /** the views after the controls, 8px from them */
  views?: ReactNode;
}

/**
 * The caption: the thread's title over one 12px comma sentence, what it is doing then where it runs. While he drives
 * the first words are "You are driving", in foreground; while a card waits on him they are its question, in
 * foreground, and where it runs follows with no comma (a question ends its own sentence).
 */
export function ComputerCaption({ tile, onOpenSession, where, onTookOver, views }: CaptionProps) {
  const line = tileLine(tile);
  const asking = !!tile.entry.row.asking && !tile.driving;
  return (
    <div data-slot="computer-caption" className="flex min-h-9 w-0 min-w-full items-center gap-3">
      <div className="flex min-w-0 flex-1 flex-col">
        <TruncateTip text={tile.title}>
          <Button variant="link" size="xs" className="h-5 max-w-full justify-start p-0 text-[13px] leading-5 font-medium text-foreground" onClick={() => onOpenSession(tile.entry.row.threadId, tile.entry.host)}>
            <span className="truncate">{tile.title}</span>
          </Button>
        </TruncateTip>
        {asking ? (
          <span className="flex min-w-0 gap-1 text-xs leading-4 text-muted-foreground">
            <span className="min-w-0 truncate text-foreground">{line}</span>
            {where ? <span className="shrink-0">{where}</span> : null}
          </span>
        ) : (
          <Facts parts={[line && tile.driving ? <span className="text-foreground">{line}</span> : line, where]} className="text-xs leading-4 text-muted-foreground" />
        )}
      </div>
      <StageControls tile={tile} onTookOver={onTookOver} />
      {views ? <span className="ms-2 flex shrink-0 items-center gap-1">{views}</span> : null}
    </div>
  );
}
