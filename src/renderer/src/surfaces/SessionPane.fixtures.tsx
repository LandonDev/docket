// bun run ui:preview src/renderer/src/surfaces/SessionPane.tsx#LoadLineView
// Static capture pins the countdown. LoadLine's clock and Retry are covered by DOM tests.
import type { ComponentProps } from "react";
import type { LoadLineView } from "./SessionPane";

const now = Date.UTC(2026, 10, 12, 16);
const base = { name: "the studio", now, onRetry: () => {} };
const start = { since: now - 8_000, attempt: 1 };

export default [
  { name: "Slow", props: { ...base, load: { ...start, phase: "slow" } } },
  { name: "Waiting to retry", props: { ...base, load: { ...start, phase: "failed", retryAt: now + 5_000 } } },
  { name: "Refused", props: { ...base, load: { ...start, phase: "failed", error: "This key cannot open the thread" } } },
] satisfies { name: string; props: ComponentProps<typeof LoadLineView> }[];
