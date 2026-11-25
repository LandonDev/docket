// @vitest-environment jsdom
/**
 * The Tasks view over a long day (perf pass M12): a group past 80 tasks mounts only the rows near the screen, each with
 * its place in the group; a push that answers every task again draws only the task that changed.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { fakeTasksClient, type Task } from "work-kit/views";

/** Each row draws its tick once a draw: the count of draws by the tick's label. */
const draws = vi.hoisted(() => new Map<string, number>());
vi.mock("../../components/ui/checkbox", async (original) => {
  const real = await original<typeof import("../../components/ui/checkbox")>();
  const { createElement } = await import("react");
  return {
    ...real,
    Checkbox: (props: { "aria-label"?: string }) => {
      const label = props["aria-label"] ?? "";
      draws.set(label, (draws.get(label) ?? 0) + 1);
      return createElement(real.Checkbox as never, props as never);
    },
  };
});
vi.mock("convex/react", async (original) => ({ ...(await original<object>()), useQuery: () => undefined }));

const { Tasks } = await import("./TasksView");

/** LifeOS's answer, pushed: a new array of new objects each time, as a live query answers. */
let answer: Task[] = [];
const heard = new Set<() => void>();
const push = (next: Task[]): void =>
  act(() => {
    answer = next;
    for (const fn of heard) fn();
  });
const task = (i: number, over: Partial<Task> = {}): Task => ({ _id: `t${i}`, title: `Task ${i}`, sector: "purdue", status: "todo", ...over }) as Task;
const many = (n: number, change?: (t: Task) => Task) => Array.from({ length: n }, (_, i) => (change ? change(task(i)) : task(i)));

function Frame() {
  const base = fakeTasksClient([]);
  const client = { ...base, useOpenTasks: () => useSyncExternalStore((fn) => (heard.add(fn), () => void heard.delete(fn)), () => answer) };
  return (
    <div style={{ overflowY: "auto", height: 600 }}>
      <Tasks client={client} startThread={() => {}} />
    </div>
  );
}

// jsdom lays nothing out: an element's height is its inline style's, so the scroller has a window of 600px.
const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight")!;
beforeAll(() =>
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return Number.parseInt(this.style.height, 10) || 0;
    },
  }),
);
afterAll(() => Object.defineProperty(HTMLElement.prototype, "offsetHeight", height));
afterEach(() => {
  cleanup();
  draws.clear();
});

describe("the Tasks list", () => {
  it("with 300 tasks in a group mounts at most 60 rows, each with its place in the group", () => {
    answer = many(300);
    const view = render(<Frame />);
    const items = view.container.querySelectorAll('[role="listitem"][aria-setsize]');
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThanOrEqual(60);
    expect(items[0]!.getAttribute("aria-setsize")).toBe("300");
  });

  it("a push that answers every task again draws only the task that changed", () => {
    answer = many(300);
    render(<Frame />);
    const before = new Map(draws);
    push(many(300, (t) => (t._id === "t2" ? { ...t, title: "Task 2, moved" } : { ...t })));
    const drawn = [...draws].filter(([label, n]) => n !== (before.get(label) ?? 0)).map(([label]) => label);
    expect(drawn).toEqual(["Mark Task 2, moved done"]);
  });
});
