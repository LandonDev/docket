// bun run ui:preview src/renderer/src/chrome/UpdateRow.fixtures.tsx#UpdateRowPreview
// UpdateRowPreview draws the same row at 200 and 260px. Hover notes and install actions need interaction.
import { UpdateRow, type UpdateRowState } from "./UpdateRow";

const states: UpdateRowState[] = [
  { kind: "checking", version: "v1.0.380" },
  { kind: "available", version: "1.0.381", retry: false, notes: "Opens notes lists faster." },
  { kind: "available", version: "1.0.381", retry: true, error: "The download stopped. Try again." },
  { kind: "downloading", percent: 62 },
  { kind: "ready" },
  { kind: "ready", subject: "Keep the current page while notes refresh" },
  { kind: "updated", version: "1.0.381" },
];

export function UpdateRowPreview() {
  return (
    <div className="flex flex-wrap gap-4">
      {[200, 260].map((width) => (
        <div key={width} className="bg-sidebar p-2" style={{ width }}>
          {states.map((state, i) => <UpdateRow key={i} state={state} onOpenWhatsNew={() => {}} />)}
        </div>
      ))}
    </div>
  );
}


export const UpdateRowFixtures = states.map((state) => ({
  name: state.kind === "available" && state.retry ? "Retry after a failed download"
    : state.kind === "ready" && state.subject ? "Code update ready" : state.kind,
  props: { state, onOpenWhatsNew: "fn" },
}));
