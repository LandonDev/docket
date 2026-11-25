// @vitest-environment jsdom
/** A canvas press that failed (frame.ts `sayError`): the act's own line as the toast's title, the host's answer in plain words under it, never a method's name. */
import { describe, expect, it, vi } from "vitest";

const toast = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("../../components/ui/toaster", () => ({ loadToast: async () => toast }));
vi.mock("../../lib/connection", async (original) => ({
  ...(await original<typeof import("../../lib/connection")>()),
  registry: { onLink: () => () => undefined, linkOf: () => null, environment: (id: string) => (id === "env_box" ? { id, name: "The box" } : undefined) },
}));
import { sayError } from "./frame";

const said = async (): Promise<unknown[]> => {
  await vi.waitFor(() => expect(toast.error).toHaveBeenCalled());
  const call = toast.error.mock.calls.at(-1)!;
  toast.error.mockClear();
  return call;
};

describe("sayError", () => {
  it("titles the toast with the act's line and words a wait that ran out, the computer named", async () => {
    sayError(new Error("work.dashboards.refresh timed out after 30 s"), "Couldn't read the figures", "env_box");
    expect(await said()).toEqual(["Couldn't read the figures", { description: "The box did not answer. Try again once it is connected." }]);
  });

  it("puts a host's plain sentence under the title", async () => {
    sayError(new Error("This host is not signed in to LifeOS"), "Accept did not work");
    expect(await said()).toEqual(["Accept did not work", { description: "This host is not signed in to LifeOS" }]);
  });

  it("says the title alone when the answer has no plain words", async () => {
    sayError(new Error("work.canvas.review failed: ENOTSUP /srv/agents/x/y"), "Couldn't accept the change");
    expect(await said()).toEqual(["Couldn't accept the change", undefined]);
    sayError(undefined, "Open in its app did not work");
    expect(await said()).toEqual(["Open in its app did not work", undefined]);
  });

  it("says a refusal raised with its own sentence once, not as its title and again under it", async () => {
    sayError(new Error("Accept or reject the suggestion on this slide first"), "Accept or reject the suggestion on this slide first");
    expect(await said()).toEqual(["Accept or reject the suggestion on this slide first", undefined]);
  });
});
