import { OFFLINE_WORDS } from "./offline";

/** A form's line while this computer is offline, in `DownLine`'s place and shape; what he typed stays and Add is held. */
export function OfflineLine() {
  return (
    <p data-computer-offline role="status" className="flex min-h-7 min-w-0 items-center text-[13px] text-muted-foreground">
      {OFFLINE_WORDS}
    </p>
  );
}
