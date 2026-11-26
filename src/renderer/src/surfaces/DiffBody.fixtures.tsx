// bun run ui:preview src/renderer/src/surfaces/DiffBody.tsx#DiffBody
// Static capture shows the hunks. Opening the editor at a line needs interaction.
import { previewToRows } from "./diffRows";

const rows = previewToRows([
  { kind: "context", number: 8, text: "export function retryDelay(attempt: number) {" },
  { kind: "del", number: 9, text: "  return 2 ** attempt;" },
  { kind: "add", number: 9, text: "  return Math.min(30, 2 ** attempt);" },
  { kind: "context", number: 10, text: "}" },
  { kind: "context", number: 42, text: "if (canRetry) {" },
  { kind: "add", number: 43, text: "  scheduleRetry(retryDelay(attempt));" },
  { kind: "context", number: 44, text: "}" },
]);

export default [
  { name: "Two hunks with line numbers", props: { rows } },
  { name: "Inset rows that open the editor", props: { rows, inset: true, onEditAt: "fn" } },
];
