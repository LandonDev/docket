// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registry } from "../../lib/connection";
import { shellStore, initialShellState } from "../../stores/shell";
import { TODAY_SOURCES } from "../today/sources";
import type { TodayEnv, TodayRow } from "../today/types";
import { MON, TZ, WEEK } from "./fixtures";
import { resetReviewStore } from "./store";
import { readyRow, readyTitle, source } from "./today";

/** The review's row on Today: there while a routine-made review waits unopened, gone once he has seen it. */

const DAY = 24 * 60 * 60_000;
const FRIDAY = MON + 4 * DAY + 16 * 60 * 60_000;
const env = (hosts: [string, boolean][]): TodayEnv =>
  ({ day: { from: FRIDAY, to: FRIDAY + DAY }, workspaces: hosts.map(([environmentId, open], i) => ({ environmentId, workspaceId: `w${i}`, sector: "purdue", name: "Purdue", path: "/w", open })), lifeos: {}, workspaceOf: () => null }) as unknown as TodayEnv;

let rows: TodayRow[] = [];
function Probe({ e }: { e: TodayEnv }) {
  rows = source.use(e).rows ?? [];
  return null;
}
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

afterEach(() => {
  cleanup();
  rows = [];
  resetReviewStore();
  shellStore.setState(initialShellState());
  vi.restoreAllMocks();
});

describe("the review on Today", () => {
  it("is one of Today's sources, loaded on its own", async () => {
    const mine = TODAY_SOURCES.find((s) => s.id === "review")!;
    expect((await mine.load()).source).toBe(source);
  });

  it("says which week is ready, from today", () => {
    expect(readyTitle(WEEK.from, FRIDAY, TZ)).toBe("This week's review is ready");
    expect(readyTitle(WEEK.from, WEEK.to + DAY, TZ)).toBe("Last week's review is ready");
    expect(readyTitle(WEEK.from, WEEK.to + 9 * DAY, TZ)).toBe("A week's review is ready");
    expect(readyRow({ from: WEEK.from, madeAt: FRIDAY }, FRIDAY, TZ)).toMatchObject({ key: `review:${WEEK.from}`, section: "also", sector: null, title: "This week's review is ready", detail: "Week of Nov 16", at: FRIDAY });
  });

  it("asks each linked host with a job, shows the newest week once, opens the page at that week, and goes once he has seen it", async () => {
    resetReviewStore({ zone: TZ });
    const answers: Record<string, unknown> = { box: { from: WEEK.from, madeAt: FRIDAY }, mac: { from: WEEK.from - 7 * DAY, madeAt: FRIDAY - 7 * DAY } };
    const asked: string[] = [];
    const pushes: Record<string, (p: unknown) => void> = {};
    vi.spyOn(registry, "linkOf").mockImplementation(
      (id) =>
        ({
          request: async (method: string) => {
            asked.push(`${id}:${method}`);
            const got = answers[id];
            if (got instanceof Error) throw got;
            return got;
          },
          onPush: (fn: (p: unknown) => void) => {
            pushes[id] = fn;
            return () => delete pushes[id];
          },
        }) as never,
    );
    render(<Probe e={env([["box", true], ["mac", true], ["old", true], ["asleep", false]])} />);
    answers.old = new Error("not built: work.review.ready");
    await settle();
    // A host that is not linked is not asked; one from before the review has nothing to name.
    expect(asked.sort()).toEqual(["box:work.review.ready", "mac:work.review.ready", "old:work.review.ready"]);
    expect(rows.map((r) => [r.key, r.title, r.detail])).toEqual([[`review:${WEEK.from}`, "This week's review is ready", "Week of Nov 16"]]);
    rows[0]!.open();
    expect(shellStore.getState().workPlace).toBe("review");
    // He opened it: the host says so, the row is asked for again and goes; the older week on the Mac is still unopened.
    answers.box = null;
    await act(async () => pushes.box!({ push: "work.review", from: WEEK.from, madeAt: FRIDAY, seen: true }));
    await settle();
    expect(rows.map((r) => r.detail)).toEqual(["Week of Nov 9"]);
    answers.mac = null;
    await act(async () => pushes.mac!({ push: "work.review", from: WEEK.from - 7 * DAY, madeAt: FRIDAY, seen: true }));
    await settle();
    expect(rows).toEqual([]);
  });
});
