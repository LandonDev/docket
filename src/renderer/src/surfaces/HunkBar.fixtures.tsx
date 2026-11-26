// bun run ui:preview src/renderer/src/surfaces/HunkBar.fixtures.tsx#BackedHunkBar --shot --fresh
// Exports BackedHunkBar and the HunkBar fixtures. Static shots hold the hunk tool
// on the editor's own backing without mouse movement or a selected line.
import type { CSSProperties, ComponentProps } from "react";
import { HunkBar } from "./HunkBar";
import { gitThemeSpec } from "./editorGit";

export function BackedHunkBar(props: ComponentProps<typeof HunkBar>) {
  return (
    <div className="relative h-24">
      <div className="cm-gitHunkBar" style={gitThemeSpec[".cm-gitHunkBar"] as CSSProperties}><HunkBar {...props} /></div>
    </div>
  );
}
export default [
  { name: "a change against HEAD: revert and stage", props: { onRevert: "fn", onStage: "fn" } },
  { name: "a change against another branch: revert alone", props: { onRevert: "fn" } },
  { name: "busy", props: { onRevert: "fn", onStage: "fn", busy: true } },
];
