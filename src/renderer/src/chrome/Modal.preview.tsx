// bun run ui:preview src/renderer/src/chrome/Modal.preview.tsx#ModalPreview --shot --fresh
// Export ModalPreview. The harness seats the real portal in a static window. Close and focus need a live page.
import type { ReactNode } from "react";
import { FormDialog } from "./Modal.fixtures";

export function ModalPreview({ children, behind, height = 640 }: { children?: ReactNode; behind?: ReactNode; height?: number }) {
  return <div data-preview-stage style={{ height }}>{behind}{children ?? <FormDialog />}</div>;
}
