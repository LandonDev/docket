import { useRef, useState } from "react";
import { BusyLabel, Button } from "@renderer/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { loadToast } from "@renderer/components/ui/toaster";
import { Square } from "../../../chrome/icons";
import { handBack, takeOver, type ComputerTile } from "../../../lib/computers";
import { stopComputer } from "../../../lib/computerSessions";

/**
 * What he can do to a computer being driven, wherever it is shown
 * (docs/DESIGN.md "Computers"): Take over or Hand back where the session
 * has a driver (the Work browser's page), and Stop. One press at a time; a
 * press that fails says so once, in the toast stack.
 */
export function ComputerControls({ tile, className }: { tile: ComputerTile; className?: string }) {
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
  return (
    <span data-slot="computer-controls" className={className ?? "flex shrink-0 items-center gap-1"}>
      {tile.browser ? (
        tile.driving ? (
          <Button variant="secondary" size="xs" data-hand-back disabled={!!busy} onClick={() => press("back", () => handBack(tile), "Couldn't hand it back")}>
            <BusyLabel busy={busy === "back"} label="Hand back" />
          </Button>
        ) : (
          <Button variant="secondary" size="xs" disabled={!!busy} onClick={() => press("take", () => takeOver(tile), "Couldn't take over")}>
            <BusyLabel busy={busy === "take"} label="Take over" />
          </Button>
        )
      ) : null}
      {/* a page he drives has no session to stop: Hand back is what ends it */}
      {tile.driving ? null : (
        <Tooltip>
          <TooltipTrigger
            // hung 8px out, so its square ends on the edge of the picture above it
            render={<Button variant="ghost" size="icon-xs" className="-me-2 shrink-0 text-muted-foreground hover:text-foreground" aria-label={`Stop ${tile.title}`} disabled={!!busy} onClick={() => press("stop", () => stopComputer(tile.entry), "Couldn't stop it")} />}
          >
            <Square className="size-2.5 fill-current" />
          </TooltipTrigger>
          <TooltipContent>Stop</TooltipContent>
        </Tooltip>
      )}
    </span>
  );
}
