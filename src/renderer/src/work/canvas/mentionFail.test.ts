import { afterEach, describe, expect, it, vi } from "vitest";

/** A mention search that left LifeOS out, said in the host's state (council round 9, Opus rest 2). */
vi.mock("../../lib/connection", async (original) => ({ ...(await original<object>()), registry: { environment: (id: string) => (id === "box" ? { name: "The box" } : null) } }));

const { mentionFailWords } = await import("./mentionFail");
const { resetLifeos, setLifeosStatus, setLifeosUnanswered } = await import("../shell/lifeos");

const status = (state: string) => ({ lifeos: { state }, keys: [] }) as never;
afterEach(() => resetLifeos());

describe("mentionFailWords", () => {
  it("says nothing when nothing was left out", () => {
    expect(mentionFailWords([], "box")).toBeNull();
  });

  it("words LifeOS's kinds by the host's state, the computer named", () => {
    setLifeosStatus("box", status("signed-out"));
    expect(mentionFailWords(["task", "mail"], "box")).toBe("Not signed in to LifeOS on the box");
    setLifeosStatus("box", status("pairing"));
    expect(mentionFailWords(["task"], "box")).toBe("The LifeOS sign-in on the box waits for your approval");
    setLifeosStatus("box", status("off"));
    expect(mentionFailWords(["task"], "box")).toBe("Work is off on the box");
    setLifeosStatus("box", status("connecting"));
    expect(mentionFailWords(["task"], "box")).toBe("LifeOS is still connecting on the box");
    // Connected, yet LifeOS's kinds failed: LifeOS did not answer in time.
    setLifeosStatus("box", status("connected"));
    expect(mentionFailWords(["event"], "box")).toBe("LifeOS did not answer the box");
    setLifeosUnanswered("box");
    expect(mentionFailWords(["event"], "box")).toBe("The box did not answer");
  });

  it("says not everything was searched when a host kind failed too", () => {
    setLifeosStatus("box", status("signed-out"));
    expect(mentionFailWords(["task", "held"], "box")).toBe("Couldn't search everything");
  });
});
