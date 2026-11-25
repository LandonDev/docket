// @vitest-environment jsdom
/**
 * The ledger's entries over a long year (perf pass M12): past 80 entries the table mounts only the rows near the screen,
 * between spacer rows, and says its whole row count; a read that answers every row again draws only the row that changed.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { MoneyRead } from "@shared/contract-work-money";
import type { LedgerRow } from "@shared/work/money";

/** Each entry draws its row once a draw: the count of draws by the row's number. */
const draws = vi.hoisted(() => new Map<number, number>());
vi.mock("../../components/ui/table", async (original) => {
  const real = await original<typeof import("../../components/ui/table")>();
  const { createElement } = await import("react");
  return {
    ...real,
    TableRow: (props: Record<string, unknown>) => {
      const row = props["data-money-row"];
      if (typeof row === "number") draws.set(row, (draws.get(row) ?? 0) + 1);
      return createElement(real.TableRow as never, props as never);
    },
  };
});

const { Entries } = await import("./MoneyView");

const entry = (i: number, over: Partial<LedgerRow> = {}): LedgerRow =>
  ({ row: i + 2, ref: null, date: "2026-11-01", who: `Vendor ${i}`, what: "", category: "Travel", in: 0, out: 100 * (i + 1), status: "spent", paidOn: null, receipt: "", ...over }) as LedgerRow;
const many = (n: number, change?: (r: LedgerRow) => LedgerRow) => Array.from({ length: n }, (_, i) => (change ? change(entry(i)) : entry(i)));
const READ = {} as MoneyRead;

function Frame({ rows }: { rows: LedgerRow[] }) {
  return (
    <div style={{ overflowY: "auto", height: 600 }}>
      <Entries env="box" workspaceId="ws" read={READ} rows={rows} />
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

describe("the ledger's entries", () => {
  it("with 300 entries mounts at most 60 rows, and the table says its 301 rows", () => {
    const view = render(<Frame rows={many(300)} />);
    const rows = view.container.querySelectorAll("tr[data-money-row]");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(60);
    expect(view.container.querySelector("table")?.getAttribute("aria-rowcount")).toBe("301");
    expect(rows[0]!.getAttribute("aria-rowindex")).toBe("2");
  });

  it("draws 80 entries whole, as before", () => {
    const view = render(<Frame rows={many(80)} />);
    expect(view.container.querySelectorAll("tr[data-money-row]")).toHaveLength(80);
    expect(view.container.querySelector("table")?.hasAttribute("aria-rowcount")).toBe(false);
  });

  it("a read that answers every row again draws only the row that changed", () => {
    const view = render(<Frame rows={many(300)} />);
    const before = new Map(draws);
    view.rerender(<Frame rows={many(300, (r) => (r.row === 3 ? { ...r, category: "Meals" } : { ...r }))} />);
    const drawn = [...draws].filter(([row, n]) => n !== (before.get(row) ?? 0)).map(([row]) => row);
    expect(drawn).toEqual([3]);
  });
});
