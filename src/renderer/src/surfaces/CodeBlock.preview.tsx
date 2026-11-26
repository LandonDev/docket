// bun run ui:preview src/renderer/src/surfaces/CodeBlock.preview.tsx#CodeBlockPreview
// CodeBlockPreview uses the transcript's markdown scope so the lines and numbers have their own styles. Copy and scrolling need interaction.
import type { ComponentProps } from "react";
import { CodeBlock } from "./CodeBlock";

export function CodeBlockPreview(props: ComponentProps<typeof CodeBlock>) {
  return <div className="agent-markdown min-w-0"><CodeBlock {...props} /></div>;
}
