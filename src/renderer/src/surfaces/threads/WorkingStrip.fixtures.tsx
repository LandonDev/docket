// Fixtures for `bun run ui:preview src/renderer/src/surfaces/threads/WorkingStrip.tsx#WorkingStrip`. Stop settlement and the timer are covered by DOM tests.
import { previewNow } from "../../lib/previewHost.preview";
import type { Block } from "../../lib/session";
import { newSession, type Session } from "../../lib/session";

const now = previewNow;
const session = (over: Partial<Session>): Session => ({ ...newSession("env-local"), ...over });
const noop = () => {};
const approval = {
  id: "b-r1",
  role: "tool",
  kind: "tool",
  tool: { name: "Bash", kind: "execute", title: "Bash", input: { command: "bun test" } },
  title: "Bash",
  text: "",
  approval: { requestId: "r1", decided: false },
} as unknown as Block;

export default [
  {
    name: "Stop in progress",
    props: { session: session({ status: "running", busySince: now - 92_000 }), onStop: () => new Promise<void>(() => {}), onResume: noop },
    prepare: (root: HTMLElement) => {
      const stop = [...root.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Stop");
      if (!stop) throw new Error("Missing Stop control");
      stop.click();
    },
  },
  {
    name: "working",
    props: { session: session({ status: "running", activity: "Running bun test", busySince: now - 92_000 }), onStop: noop, onResume: noop },
  },
  {
    name: "waiting on an approval",
    props: { session: session({ status: "waiting", busySince: now - 41_000, blocks: [approval] }), onStop: noop, onResume: noop },
  },
  {
    name: "paused",
    props: { session: session({ status: "paused", frozenActiveElapsed: 250_000 }), onStop: noop, onResume: noop },
  },
  {
    name: "stopped",
    props: { session: session({ status: "stopped", frozenActiveElapsed: 95_000 }), onStop: noop, onResume: noop },
  },
  {
    name: "queued",
    props: { session: session({ status: "queued", activity: "Queued  3rd in line" }), onStop: noop, onResume: noop, onStart: noop },
  },
].map((fixture) => ({ ...fixture, now }));
