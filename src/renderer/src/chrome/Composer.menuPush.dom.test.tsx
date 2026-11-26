// @vitest-environment jsdom
/**
 * The `/` and `@` menu under a busy host (M7): with the menu open, a meta
 * push that moves no row it draws renders no Composer (the metas are read
 * only in `@` mode, through lib/mentionThreads.ts), and the popover reads the
 * list's height at most once a key. Counted renders and reads, never a clock.
 */
import { act, cleanup, render } from "@testing-library/react";
import { Profiler, type ComponentProps } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMeta } from "../lib/tcserver/types";
import type { ProjectFile } from "../lib/fs";

vi.mock("./ComposerBar", async (importOriginal) => ({ ...(await importOriginal<typeof import("./ComposerBar")>()), useDraftRow: () => false }));
vi.mock("../lib/contextCache", () => ({ useContextReading: () => null }));
vi.mock("../lib/tcserver/slashCommands", () => ({
  useSlashCommands: () => ({
    commands: [
      { name: "review", source: "skill", scope: "user", description: "Review" },
      { name: "plan", source: "skill", scope: "user", description: "Plan" },
    ],
    loaded: true,
    failed: false,
  }),
}));
const files: ProjectFile[] = ["src/app.ts", "src/main.ts", "README.md"].map((relative) => ({ name: relative.split("/").pop()!, path: `/repo/${relative}`, relative }));
vi.mock("../lib/fileIndex", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/fileIndex")>()),
  peekProjectFiles: () => files,
  loadProjectFiles: () => Promise.resolve(files),
}));

import { Composer } from "./Composer";
import { commandMenuChunk } from "../surfaces/chunks";
import { sessionStore } from "../lib/tcserver/store";

const meta = (id: string, over: Partial<SessionMeta> = {}): SessionMeta =>
  ({ id, title: id, status: "idle", environmentId: "env_a", projectId: null, workspaceId: null, updatedAt: 1, ...over }) as SessionMeta;
const noop = () => {};
const props: Omit<ComponentProps<typeof Composer>, "sessionId"> = {
  focused: false,
  harness: "claude",
  model: "claude:opus-5.5",
  runtimeMode: "supervised",
  executionCwd: "/repo",
  onFocus: noop,
  onCwdChange: noop,
  onModelChange: noop,
  onRuntimeModeChange: noop,
  onSubmit: noop,
};

function type(field: HTMLElement, text: string) {
  act(() => {
    field.append(document.createTextNode(text));
    const range = document.createRange();
    range.selectNodeContents(field);
    range.collapse(false);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

let commits = 0;
/** Each test its own thread: a composer keeps an unsent draft by thread across a remount. */
function mount(sessionId: string) {
  commits = 0;
  sessionStore.adopt(meta(sessionId));
  const view = render(
    <Profiler id="composer" onRender={() => commits++}>
      <Composer {...props} sessionId={sessionId} />
    </Profiler>,
  );
  const field = view.container.querySelector<HTMLElement>("[data-composer-input]")!;
  field.focus();
  return { view, field };
}

/** A push from the host: one thread's meta moves (a streaming turn's context, a busy master's activity). */
async function push(over: Partial<SessionMeta>, id = "busy") {
  await act(async () => {
    sessionStore.adopt({ ...sessionStore.metaOf(id)!, ...over });
  });
}

beforeAll(async () => {
  Element.prototype.scrollIntoView = () => {};
  await commandMenuChunk.load();
});
beforeEach(() => {
  sessionStore.adopt(meta("busy", { title: "Busy thread", updatedAt: 1 }));
  sessionStore.adopt(meta("child", { parentId: "busy", title: "a child" } as Partial<SessionMeta>));
  sessionStore.adopt(meta("old", { archived: true, title: "gone" } as Partial<SessionMeta>));
});
afterEach(cleanup);

describe("a meta push with the menu open", () => {
  it("renders no Composer with / open", async () => {
    const { view, field } = mount("t-slash");
    type(field, "/re");
    await act(async () => {});
    expect(view.container.querySelector("[data-command-popover]")).not.toBeNull();
    const before = commits;
    await push({ title: "Busy thread, renamed", status: "running" });
    await push({ title: "Busy thread, renamed again" });
    expect(commits).toBe(before);
  });

  it("renders no Composer with @ open for a push no row draws, and draws one that moves a row", async () => {
    const { view, field } = mount("t-at");
    type(field, "@");
    await act(async () => {});
    expect(view.container.querySelector("[data-command-popover]")?.textContent).toContain("Busy thread");
    const before = commits;
    // A child thread, an archived one, a field no row draws: nothing to redraw.
    await push({ parentId: "busy", title: "a child, renamed" } as Partial<SessionMeta>, "child");
    await push({ archived: true, title: "gone, renamed" } as Partial<SessionMeta>, "old");
    await push({ cwd: "/elsewhere" } as Partial<SessionMeta>);
    expect(commits).toBe(before);
    // Its title is drawn: one render.
    await push({ title: "Busy thread, renamed" });
    expect(commits).toBeGreaterThan(before);
    expect(view.container.querySelector("[data-command-popover]")?.textContent).toContain("Busy thread, renamed");
  });
});

describe("the popover's height", () => {
  it("is read at most once a key", async () => {
    let reads = 0;
    const real = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight")!;
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get() {
        if ((this as HTMLElement).getAttribute("role") === "listbox") reads++;
        return 0;
      },
    });
    try {
      const { field } = mount("t-height");
      const keys = ["@", "s", "r", "c", "/", "a"];
      for (const key of keys) {
        type(field, key);
        await act(async () => {});
        await push({ context: { used: Math.random() } } as unknown as Partial<SessionMeta>);
      }
      expect(reads).toBeGreaterThan(0);
      expect(reads).toBeLessThanOrEqual(keys.length);
    } finally {
      Object.defineProperty(HTMLElement.prototype, "offsetHeight", real);
    }
  });
});
