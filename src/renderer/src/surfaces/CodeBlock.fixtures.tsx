// bun run ui:preview src/renderer/src/surfaces/CodeBlock.preview.tsx#CodeBlockPreview
// Static capture shows the code and line numbers. Copy and horizontal scrolling need interaction.
import type { ComponentProps } from "react";
import type { CodeBlock } from "./CodeBlock";

const code = "export function retryDelay(attempt: number) {\n  return Math.min(30, 2 ** attempt);\n}";

export default [
  { name: "Language heading", props: { language: "ts", code } },
  { name: "No heading", props: { language: "", code: "checking the cache\ncache ready" } },
  { name: "File heading and line numbers", props: { language: "ts", label: "retry.ts", lineNumbers: true, startLine: 42, code } },
  {
    name: "A line wider than the reading column",
    props: { language: "ts", code: 'const message = "Keep the last answer in the cache so reopening the workspace brings the reader back to the same place without an extra request.";' },
  },
] satisfies { name: string; props: ComponentProps<typeof CodeBlock> }[];
