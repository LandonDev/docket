// @vitest-environment jsdom
/** Today's store while its sources load, and the count of its toasts. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TodaySource } from "./types";

const loads = vi.hoisted(() => new Map<string, { promise: Promise<{ source: unknown }>; resolve(v: { source: unknown }): void; reject(e: unknown): void }>());
const deferred = () => {
  let resolve!: (v: { source: unknown }) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<{ source: unknown }>((a, b) => ((resolve = a), (reject = b)));
  return { promise, resolve, reject };
};
vi.mock("./sources", () => ({
  TODAY_SOURCES: ["due", "review"].map((id) => ({
    id,
    ...(id === "review" ? { what: "the weekly review" } : {}),
    load: () => {
      const d = deferred();
      loads.set(id, d);
      return d.promise;
    },
  })),
}));

const { fedOf, loadSources, resetToday, todayNow, toastUp } = await import("./store");
const { page } = await import("./model");

const DUE: TodaySource = { id: "due", section: { id: "due", title: "Due", order: 30, empty: "Nothing due today" }, use: () => ({}) };
const jobs = [{ environmentId: "box", workspaceId: "w", sector: "purdue" as const, name: "Purdue", path: "/w", open: true }];
const kind = () => page(fedOf(todayNow()), { jobs, lifeos: "ok" }).kind;

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  resetToday();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("Today's sources while they load", () => {
  it("is not All clear while a source is still loading, and says the one that did not load", async () => {
    void loadSources();
    loads.get("due")!.resolve({ source: DUE });
    await Promise.resolve();
    await Promise.resolve();
    // Due answered with nothing, but the review's chunk is still on its way: it may yet bring a row.
    const { putAnswer } = await import("./store");
    putAnswer("due", { rows: [] });
    expect(todayNow().pending).toEqual(["review"]);
    expect(kind()).toBe("day");
    loads.get("review")!.reject(new Error("chunk failed"));
    await vi.waitFor(() => expect(todayNow().pending).toEqual([]));
    const p = page(fedOf(todayNow()), { jobs, lifeos: "ok" });
    expect(p.kind).toBe("day");
    const also = p.kind === "day" ? p.blocks.find((b) => b.kind === "section" && b.section.id === "also") : undefined;
    expect(also?.kind === "section" && also.section.failed.map((f) => f.said)).toEqual(["Today could not show the weekly review"]);
  });
});

describe("a toast of the page's own", () => {
  it("keeps its place while it is still in the document (held under the pointer, or loading), and frees it once it is not", () => {
    vi.useFakeTimers();
    const toast = document.createElement("li");
    toast.setAttribute("data-sonner-toast", "");
    document.body.append(toast);
    toastUp();
    expect(todayNow().toastsUp).toBe(1);
    vi.advanceTimersByTime(30_000);
    expect(todayNow().toastsUp).toBe(1);
    toast.remove();
    vi.advanceTimersByTime(12_000);
    expect(todayNow().toastsUp).toBe(0);
  });

  it("is counted down at once when it says it left", () => {
    const down = toastUp();
    down();
    down();
    expect(todayNow().toastsUp).toBe(0);
  });
});
