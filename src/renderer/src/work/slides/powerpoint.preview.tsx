// A preview frame for `bun run ui:preview src/renderer/src/work/slides/powerpoint.preview.tsx#InPowerPointPreview --shot`:
// the deck's canvas while it is open in PowerPoint, and while the switch opens it.
import { InPowerPoint, sayOpening } from "./powerpoint";

export function InPowerPointPreview({ state = "open" }: { state?: "open" | "opening" | "failed" }) {
  sayOpening("preview", state === "failed" ? { state, error: "Microsoft PowerPoint is not installed on this Mac." } : { state });
  return (
    <div className="h-[280px] w-[480px] rounded-xl border border-border">
      <InPowerPoint itemId="preview" onRetry={() => undefined} />
    </div>
  );
}
