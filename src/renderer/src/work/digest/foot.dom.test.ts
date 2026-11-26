// @vitest-environment jsdom
/** Council round 1 (R1-A17): the digest's foot with a host's link down said "box did not answer", and its Retry read again over the dead link. */
import { afterEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as string[]);
vi.mock("../shell/linkRetry", () => ({ retryLink: async (id: string) => void calls.push(`link:${id}`) }));
vi.mock("./store", async (original) => ({ ...(await original<object>()), loadDigest: async () => void calls.push("read") }));

import { IDLE_STATUS, type EnvironmentStatus } from "../../lib/connection/types";
import { footOf } from "./DigestSheet";
import { asSentence, asSentences, unansweredLine } from "./notice";

const names: Record<string, string> = { box: "box", mac: "The Mac" };
const at = (transport: EnvironmentStatus["transport"]): EnvironmentStatus => ({ ...IDLE_STATUS, transport, attempts: 1 });

afterEach(() => void (calls.length = 0));

describe("the digest's foot", () => {
  it("says a host whose link is down in the link's words, a host on an open link that did not answer as before", () => {
    const status = (id: string) => (id === "box" ? at("offline") : at("open"));
    expect(footOf([{ environmentId: "box" }, { environmentId: "mac" }], (id) => names[id]!, status).unanswered).toBe("Box is offline. The Mac did not answer");
    expect(footOf([{ environmentId: "box" }], (id) => names[id]!, () => at("reconnecting")).unanswered).toBe("Reconnecting to box…");
    expect(footOf([{ environmentId: "mac" }], (id) => names[id]!, status).unanswered).toBe("The Mac did not answer");
  });

  it("asks a link that is down to try before it reads again; an open link's Retry only reads", async () => {
    const status = (id: string) => (id === "box" ? at("offline") : at("open"));
    await footOf([{ environmentId: "box" }, { environmentId: "mac" }], (id) => names[id]!, status).retry();
    expect(calls).toEqual(["link:box", "read"]);
    calls.length = 0;
    await footOf([{ environmentId: "mac" }], (id) => names[id]!, status).retry();
    expect(calls).toEqual(["read"]);
  });

  it("starts the line with a capital and gives a wait's “…” no second stop", () => {
    expect(unansweredLine(["box", "The Mac"])).toBe("Box and The Mac did not answer");
    expect(asSentence("Reconnecting to the box…")).toBe("Reconnecting to the box…");
    expect(asSentence("The Mac did not answer")).toBe("The Mac did not answer.");
    expect(asSentences(["Reconnecting to the box…", "The Mac did not answer"])).toBe("Reconnecting to the box… The Mac did not answer");
  });
});
