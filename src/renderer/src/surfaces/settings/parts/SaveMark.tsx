import { Check } from "../../../chrome/icons";
import { Spinner } from "../../../components/ui/spinner";
import type { SaveState } from "./useSaved";

/**
 * A row's save, said before its control (`useSaved`): a 12px spinner once the answer is slow, then a check and "Saved"
 * until it goes. It takes no room at rest, sits on the control's left so the control never moves, and is a polite
 * live region, so the word is heard once.
 */
export function SaveMark({ state }: { state: SaveState }) {
  return (
    <span data-slot="save-mark" data-state={state} aria-live="polite" className="flex items-center gap-1 text-xs text-muted-foreground empty:hidden">
      {state === "slow" ? <Spinner className="size-3" aria-label="Saving" /> : null}
      {state === "saved" ? (
        <span className="flex items-center gap-1 transition-opacity duration-(--dur-fast) ease-(--ease-out) starting:opacity-0">
          <Check className="size-3" />
          Saved
        </span>
      ) : null}
    </span>
  );
}
