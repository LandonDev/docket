import { useEffect, useState } from "react";
import { Kbd } from "@renderer/components/ui/kbd";
import { cn } from "@renderer/lib/cn";
import { keyHint } from "../../../lib/keys";
import { IS_MAC } from "../../../lib/platform";
import { LEAVE_CHORD } from "../../../lib/video/videoInput";

/** How long the two ways out are said. */
export const FULL_SCREEN_HINT_MS = 3000;

/** The key into and out of full screen: ⌃⌘F on a Mac, F11 elsewhere (main's fullScreen.ts). */
export const fullScreenKey = (mac = IS_MAC): string => (mac ? keyHint("ctrl+mod+F", true) : "F11");

/**
 * The two ways out (docs/DESIGN.md "Computers", "Full screen"): one quiet line at the foot of the display, said for
 * three seconds the first time he drives in each full screen, as main holds the keyboard. Mounted once per entry.
 */
export function FullScreenHint({ driving, mac = IS_MAC }: { driving: boolean; mac?: boolean }) {
  // null until he drives: then shown, and gone three seconds later
  const [shown, setShown] = useState<boolean | null>(null);
  if (driving && shown === null) setShown(true);
  useEffect(() => {
    if (!shown) return;
    const timer = setTimeout(() => setShown(false), FULL_SCREEN_HINT_MS);
    return () => clearTimeout(timer);
  }, [shown]);
  if (shown === null) return null;
  const on = shown && driving;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-6 flex justify-center">
      <p
        role="status"
        data-slot="full-screen-hint"
        data-shown={on || undefined}
        aria-hidden={!on || undefined}
        className={cn(
          "flex items-center gap-4 rounded-lg bg-popover px-3 py-1.5 text-xs text-muted-foreground shadow-overlay ring-1 ring-border transition-opacity duration-(--dur-base) ease-(--ease-out) starting:opacity-0",
          !on && "opacity-0 duration-(--dur-fast) ease-(--ease-exit)",
        )}
      >
        <span className="flex items-center gap-1.5">
          <Kbd size="sm">{keyHint(LEAVE_CHORD, mac)}</Kbd>
          frees the keyboard
        </span>
        <span className="flex items-center gap-1.5">
          <Kbd size="sm">{fullScreenKey(mac)}</Kbd>
          leaves full screen
        </span>
      </p>
    </div>
  );
}
