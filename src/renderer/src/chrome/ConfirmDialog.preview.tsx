// bun run ui:preview src/renderer/src/chrome/ConfirmDialog.preview.tsx#RefusedDiscard
// The Changes section's Discard as `confirmAction` draws it when git refuses the step it runs: the confirm stays, its
// red line the refusal in the section's words. Rendered by nothing in the app.
import { useEffect } from "react";
import { ConfirmHost, confirmAction } from "./ConfirmDialog";

export function RefusedDiscard() {
  useEffect(() => {
    void confirmAction({
      title: "Discard changes in ChangesPanel.tsx?",
      body: "The edits are gone for good.",
      action: "Discard",
      danger: true,
      run: () => Promise.reject(new Error("Git is busy in this checkout. Try again.")),
    });
    const timer = setTimeout(() => document.querySelector<HTMLButtonElement>('[data-slot="alert-dialog-content"] [data-slot="alert-dialog-action"]')?.click(), 20);
    return () => clearTimeout(timer);
  }, []);
  return <ConfirmHost />;
}
