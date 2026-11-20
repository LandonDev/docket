import { useState } from "react";
import { Check, LockOpen } from "../../chrome/icons";
import { BusyLabel, Button } from "../../components/ui/button";
import { loadToast } from "../../components/ui/toaster";
import { offerLine } from "./model";
import { dismissOffer, removeGrant, takeOffer, type HostGrant, type HostOffer } from "./store";

/**
 * A grant he has earned (docs/agents/work-outbox.md "Offered grants"), under
 * the sent item whose press completed the run, as a house rule's line sits
 * under a sent mail: past a hairline, one muted 13px line, the open lock, the
 * grant's name and why it is offered, Dismiss and Stop holding. Taken, the
 * line says so with Undo, which removes the grant; the offer does not come
 * back either way.
 */
export function OfferLine({ offer }: { offer: HostOffer }) {
  const [busy, setBusy] = useState<"take" | "dismiss" | "undo" | null>(null);
  const [made, setMade] = useState<HostGrant | null>(null);
  const [gone, setGone] = useState(false);
  const failed = (err: unknown) => void loadToast().then((t) => t.error(err instanceof Error ? err.message : String(err)));
  const run = (which: "take" | "dismiss" | "undo", job: () => Promise<void>) => {
    setBusy(which);
    job()
      .catch(failed)
      .finally(() => setBusy(null));
  };
  if (gone) return null;
  return (
    <div data-offer-line={offer.id} className="flex flex-wrap items-start gap-x-2 gap-y-1 border-t border-border pt-3 text-[13px] leading-5 text-muted-foreground">
        {made ? (
          <>
            <span className="flex h-5 w-3.5 shrink-0 items-center justify-center text-success">
              <Check className="size-3.5" />
            </span>
            <span className="min-w-0 flex-1">Grant made: {made.label}</span>
            <Button variant="ghost" size="xs" className="-mt-0.5" disabled={busy !== null} onClick={() => run("undo", () => removeGrant(made).then(() => setGone(true)))}>
              <BusyLabel busy={busy === "undo"} label="Undo" />
            </Button>
          </>
        ) : (
          <>
            <span className="flex h-5 w-3.5 shrink-0 items-center justify-center">
              <LockOpen className="size-3.5" />
            </span>
            <span className="min-w-0 flex-1 basis-60">{offerLine(offer)}</span>
            <span className="-mt-0.5 ms-auto flex shrink-0 gap-2">
              <Button variant="ghost" size="xs" disabled={busy !== null} onClick={() => run("dismiss", () => dismissOffer(offer).then(() => setGone(true)))}>
                <BusyLabel busy={busy === "dismiss"} label="Dismiss" />
              </Button>
              <Button variant="secondary" size="xs" disabled={busy !== null} onClick={() => run("take", () => takeOffer(offer).then(setMade))}>
                <BusyLabel busy={busy === "take"} label="Stop holding" />
              </Button>
            </span>
          </>
        )}
    </div>
  );
}
