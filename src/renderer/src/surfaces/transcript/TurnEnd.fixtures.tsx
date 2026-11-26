// bun run ui:preview src/renderer/src/surfaces/transcript/TurnEnd.tsx#TurnEnd
// bun run ui:preview src/renderer/src/surfaces/transcript/TurnEnd.tsx#WatchingLine
// Static capture shows the closing and watching lines. Hover, focus and actions need interaction.
import { reveal } from "../../components/ui/reveal";
import type { ComponentProps } from "react";
import type { Block } from "../../lib/session";
import type { TurnEnd } from "./TurnEnd";

const now = Date.now();
const noop = () => {};

export default [
  { name: "fresh", props: { since: now - 4 * 60_000 } },
  { name: "stale", props: { since: now - 45 * 60_000, stale: true } },
  { name: "clickable", props: { since: now - 4 * 60_000, onOpen: noop } },
  { name: "clickable and stale", props: { since: now - 45 * 60_000, stale: true, onOpen: noop } },
  { name: "one subagent, by title", props: { since: now - 3 * 60_000, onOpen: noop, subject: "Review the perf pass" } },
  { name: "several subagents", props: { since: now - 3 * 60_000, onOpen: noop, subject: "3 subagents" } },
];


const user: Block = { id: "preview-end-user", role: "user", text: "Check the new cache", startedAt: Date.UTC(2026, 10, 12, 16) };
const reply: Block = { id: "preview-end-reply", role: "assistant", text: "The cache keeps the most recent answer." };
const turn = { id: user.id, index: 0, isLast: true, settled: true, blocks: [user, reply], userBlock: user, startedAt: user.startedAt };
const props = { turnState: null, harnessOf: () => "claude" as const, onSaveNote: noop };

export const TurnEndFixtures = [
  { name: "Worked for", props: { ...props, turn: { ...turn, durationMs: 124_000 } } },
  {
    name: "Closing actions visible",
    props: { ...props, turn: { ...turn, durationMs: 124_000 } },
    prepare: (root: HTMLElement) => {
      const hover = reveal("turnend").split(" ").find((name) => name.startsWith("group-hover") && name.endsWith("opacity-100"))!;
      const actions = [...root.querySelectorAll<HTMLElement>("[class]")].find((element) => element.classList.contains(hover));
      if (!actions) throw new Error("Missing closing actions");
      actions.style.opacity = "1";
    },
  },
  { name: "Stopped", props: { ...props, turn: { ...turn, durationMs: undefined, blocks: [user, reply, { id: "err:preview-stop", role: "system", text: "Stopped", stopped: true }] } } },
] satisfies { name: string; props: ComponentProps<typeof TurnEnd>; prepare?: (root: HTMLElement) => void }[];
