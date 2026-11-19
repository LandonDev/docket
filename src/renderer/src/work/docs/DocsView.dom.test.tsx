// @vitest-environment jsdom
/** The Docs view: New spins and says when the host refuses it; a failed list offers Retry; past 25, Show more reads the next 25. */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// One answer object until the test swaps it, as the live query keeps its state between renders.
const reads: { args: Record<string, unknown>[]; answer: unknown } = { args: [], answer: { status: "loading" } };
vi.mock("../shell/lifeos", async (original) => ({
  ...(await original<object>()),
  useLifeosQuery: (_session: unknown, name: string, args: Record<string, unknown>) => {
    if (name === "projects:list") return { status: "ready", value: [] };
    reads.args.push(args);
    return reads.answer;
  },
}));
const create = vi.fn<() => Promise<unknown>>();
vi.mock("../../lib/connection", async (original) => ({ ...(await original<object>()), registry: { linkOf: () => ({ request: () => create() }) } }));
const errors: string[] = [];
vi.mock("../../components/ui/toaster", async (original) => ({ ...(await original<object>()), loadToast: async () => ({ error: (text: string) => void errors.push(text) }) }));

const { Head, View } = await import("./DocsView");
const props = { env: "box", workspace: { id: "ws-docs", environmentId: "box" }, sector: "purdue", lifeos: {}, startThread: () => {} } as never;
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const doc = (i: number) => ({ _id: `d${i}`, title: `Doc ${i}`, _creationTime: 1 });

beforeEach(() => {
  reads.args.length = 0;
  errors.length = 0;
});
afterEach(cleanup);

describe("the Docs view", () => {
  it("says when New is refused", async () => {
    create.mockRejectedValueOnce(new Error("LifeOS refused it"));
    render(<Head {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    await settle();
    expect(errors).toEqual(["The document was not made"]);
    expect((screen.getByRole("button", { name: "New" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("offers Retry when the list fails", async () => {
    reads.answer = { status: "failed", error: "Server error" };
    render(<View {...props} />);
    expect(screen.getByText("Docs did not load")).toBeTruthy();
    reads.answer = { status: "ready", value: { page: [doc(1)], isDone: true } };
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.getByRole("button", { name: /Doc 1/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("reads 25 more when more are left", () => {
    reads.answer = { status: "ready", value: { page: Array.from({ length: 25 }, (_, i) => doc(i)), isDone: false } };
    render(<View {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(reads.args.at(-1)).toMatchObject({ paginationOpts: { numItems: 50, cursor: null } });
  });
});
