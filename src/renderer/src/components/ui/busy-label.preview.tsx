// bun run ui:preview src/renderer/src/components/ui/busy-label.preview.tsx#BusyLabelAligns --shot --fresh
import { BusyLabel, Button } from "./button";

/** BusyLabel's three aligns in a leading ghost under a line of text, at rest and busy: start hangs the word on the
 *  text's edge, centre sits it in the spinner's room, end sets it at the held width's end. */
export function BusyLabelAligns() {
  const aligns = ["start", "center", "end"] as const;
  return (
    <div className="flex flex-col gap-4 p-4">
      {aligns.map((align) => (
        <div key={align} className="flex flex-col items-start">
          <span className="ps-2.5 text-xs text-muted-foreground">align {align}: the text edge</span>
          <div className="flex gap-3">
            <Button variant="ghost" size="sm">
              <BusyLabel busy={false} label="Discard" busyLabel="Discarding…" align={align} />
            </Button>
            <Button variant="ghost" size="sm">
              <BusyLabel busy label="Discard" busyLabel="Discarding…" align={align} />
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
