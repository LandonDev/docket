import { describe, expect, it, vi } from "vitest";
import { hostOf, isFreshInstall, writeSeedsOnce } from "./setupFlow";
import { allDone, givesText, holdsParts, isGiverHere, landStep, computerParts } from "../settings/hosts/computersText";

describe("the setup's rules", () => {
  it("opens the first screen only on a fresh install, once each count is known", () => {
    expect(isFreshInstall({ savedHosts: 0, workspaces: 0, accounts: 0 })).toBe(true);
    expect(isFreshInstall({ savedHosts: 0, workspaces: 0, accounts: null })).toBe(false);
    expect(isFreshInstall({ savedHosts: 1, workspaces: 0, accounts: 0 })).toBe(false);
    expect(isFreshInstall({ savedHosts: 0, workspaces: 2, accounts: 0 })).toBe(false);
    expect(isFreshInstall({ savedHosts: 0, workspaces: 0, accounts: 1 })).toBe(false);
  });

  it("names the box by its host, and what a link gives in order", () => {
    expect(hostOf("https://tempcode.landonhale.com")).toBe("tempcode.landonhale.com");
    expect(hostOf("not a url")).toBe("not a url");
    expect(givesText({ accounts: true, lifeos: true, reader: true, folders: true })).toBe(
      "link to the box, your accounts, LifeOS with Outlook and Teams, folders in Files",
    );
    expect(givesText({ accounts: false, lifeos: true, reader: false, folders: false })).toBe("link to the box, LifeOS");
  });

  it("lands a step over its row, a new one at its place in the order, and is Ready only when all are done", () => {
    const steps = landStep([{ step: "link", state: "done" }, { step: "work", state: "waiting" }], { step: "allow", state: "working" });
    expect(steps.map((s) => s.step)).toEqual(["link", "allow", "work"]);
    expect(landStep(steps, { step: "allow", state: "failed", reason: "x" })[1]).toEqual({ step: "allow", state: "failed", reason: "x" });
    expect(allDone(steps)).toBe(false);
    expect(allDone([])).toBe(false);
    expect(allDone(steps.map((s) => ({ ...s, state: "done" as const })))).toBe(true);
  });

  it("writes only seeds it can read", () => {
    const kept = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v) });
    expect(writeSeedsOnce({ appearance: { code: "neon", work: "light" }, defaultModels: ["x"] })).toBe(true);
    expect(localStorage.getItem("docket.colorScheme")).toBeNull();
    expect(localStorage.getItem("docket.colorScheme.work")).toBe("light");
    expect(localStorage.getItem("docket.defaultModels")).toBeNull();
    expect(writeSeedsOnce({ appearance: { code: "dark" } })).toBe(false);
    vi.unstubAllGlobals();
  });

  it("counts what a computer holds by provider and knows the giver by its key", () => {
    expect(holdsParts([{ service: "codex" }, { service: "claude-code" }, { service: "codex" }, { service: "cursor-x" }])).toEqual(["1 Claude", "2 Codex"]);
    expect(holdsParts([])).toEqual(["No accounts"]);
    const giver = { keyId: "k1", identity: { signPublic: "s", sealPublic: "x" }, name: "Mac", at: 1 };
    expect(isGiverHere(giver, [{ keyId: "k1" } as never])).toBe(true);
    expect(isGiverHere(giver, [{ keyId: "k2" } as never])).toBe(false);
    expect(isGiverHere(null, [{ keyId: "k1" } as never])).toBe(false);
    const row = { envId: "e", name: "PC", state: "active" as const, holds: [], syncedAt: null, paused: true, waitingForContact: false, lastError: null };
    expect(computerParts(row)).toEqual(["No accounts", "paused", "not synced yet"]);
  });
});

describe("stepReasonWords", () => {
  const CASES: [Parameters<typeof import("./setupFlow").stepReasonWords>[0], string | null | undefined][] = [
    ["accounts", "The box could not be saved. Retry."],
    ["accounts", "The box did not answer"],
    ["lifeos", "The installer stopped with code 1603"],
    ["lifeos", "The installer did not finish."],
    ["folders", "The installer stopped with code 1603"],
    ["work", undefined],
    ["work", null],
    ["allow", "Is it gone?"],
  ];

  it("says the reason as a sentence, with no closing Retry. and no installer's exit code", async () => {
    const { stepReasonWords } = await import("./setupFlow");
    expect(stepReasonWords("accounts", "The box could not be saved. Retry.")).toBe("The box could not be saved.");
    expect(stepReasonWords("accounts", "The box did not answer")).toBe("The box did not answer.");
    expect(stepReasonWords("lifeos", "The installer stopped with code 1603")).toBe("The LifeOS installer did not finish.");
    expect(stepReasonWords("work", undefined)).toBe("It did not finish.");
    // A reason that was only "Retry." says the fact, never a lone period (Settings' copy draws "." here today).
    expect(stepReasonWords("work", "Retry.")).toBe("It did not finish.");
  });

  it("says each step's reason as Settings says it, one set of words", async () => {
    const { stepReasonWords } = await import("./setupFlow");
    const settings = await import("../settings/hosts/computersText");
    for (const [step, reason] of CASES) expect(stepReasonWords(step, reason), `${step}: ${reason}`).toBe(settings.stepReasonWords(step, reason));
  });
});
