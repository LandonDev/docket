// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PublishStatus } from "@server/shared/contract-host";
import { registry, type Link } from "../../../lib/connection";

/**
 * Sync and Publish (docs/agents/settings.md "The pages: computers"): Sync names every computer it keeps the same, asks
 * before sending the agent settings, and opens the conflict copies only while there are any; Publish shows only where
 * the release folder holds a Docket checkout, and words a new release.
 */

const confirms: { title: string; body?: string }[] = [];
let answer = true;
vi.mock("../../../chrome/ConfirmDialog", async (original) => ({
  ...(await original<typeof import("../../../chrome/ConfirmDialog")>()),
  confirmAction: async (request: { title: string; body?: string }) => {
    confirms.push(request);
    return answer;
  },
}));

const { SyncLine, SyncPage, memoryWords, namesWords } = await import("./SyncPage");
const { newReleaseWords, publishable, publishShown } = await import("./PublishPage");

const env = (id: string, name: string) => ({ id, name, connected: true, running: false, files: 3, sets: null, syncedAt: Date.now() - 120_000, lastAttemptAt: null, error: null });
let answers: Record<string, unknown> = {};
const requests: { method: string; params: unknown }[] = [];
const link = {
  environmentId: "local",
  connected: true,
  onOpen: () => () => {},
  onPush: () => () => {},
  request: (method: string, params: unknown) => {
    requests.push({ method, params });
    const value = answers[method];
    return value === undefined ? Promise.reject(new Error(`no ${method}`)) : Promise.resolve(typeof value === "function" ? value(params) : value);
  },
} as unknown as Link;
const ENVIRONMENTS = [
  { id: "local", name: "This Mac", routes: [] },
  { id: "env_box", name: "The box", routes: [] },
  { id: "env_pc", name: "PURDUE-LT", routes: [] },
];

beforeEach(() => {
  Object.assign(registry, { primary: () => link, link: () => link, linkOf: () => link, environmentsSnapshot: () => ENVIRONMENTS });
  answers = {
    "harness.status": { enabled: false, skipped: 2, environments: [env("env_box", "The box"), env("env_pc", "PURDUE-LT")], pathMap: { roots: {}, prefixes: {} } },
    "memory.status": { enabled: true, skipped: 0, environments: [{ ...env("env_box", "The box"), conflicts: 0 }], conflicts: [] },
    "harness.settings.set": (p: { enabled: boolean }) => ({ ...(answers["harness.status"] as object), enabled: p.enabled }),
  };
});
afterEach(() => {
  cleanup();
  confirms.length = 0;
  requests.length = 0;
  answer = true;
});
const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
};

describe("Sync", () => {
  it("names the computers it keeps the same, in its line and in the agent settings' row", async () => {
    render(
      <>
        <SyncLine />
        <SyncPage />
      </>,
    );
    await flush();
    expect(screen.getByText("This Mac keeps the box and PURDUE-LT the same as itself.")).toBeTruthy();
    expect(screen.getByText("This Mac's Claude Code and Codex settings go to the box and PURDUE-LT. 2 files stay here.")).toBeTruthy();
    // no conflict copies: no row for them
    expect(document.querySelector("[data-setting='sync.conflicts']")).toBeNull();
    expect(document.querySelectorAll("[data-synced]")).toHaveLength(2);
  });

  it("asks before sending the agent settings, naming every computer that receives them", async () => {
    answer = false;
    render(<SyncPage />);
    await flush();
    fireEvent.click(screen.getByLabelText("Agent settings"));
    await flush();
    expect(confirms[0]).toEqual(expect.objectContaining({ title: "Send this Mac's agent settings to the box and PURDUE-LT?" }));
    expect(requests.some((r) => r.method === "harness.settings.set")).toBe(false);
    answer = true;
    fireEvent.click(screen.getByLabelText("Agent settings"));
    await flush();
    expect(requests.filter((r) => r.method === "harness.settings.set")).toEqual([{ method: "harness.settings.set", params: { enabled: true } }]);
  });

  it("counts the computers the memory is kept the same on", () => {
    expect(memoryWords(2)).toBe("Kept the same both ways");
    expect(memoryWords(3)).toBe("Kept the same on all three, both ways");
  });

  it("joins names as a sentence does", () => {
    expect(namesWords(["the box"])).toBe("the box");
    expect(namesWords(["the box", "PURDUE-LT", "MacBook Air"])).toBe("the box, PURDUE-LT and MacBook Air");
  });
});

describe("Publish", () => {
  const status = (over: Partial<PublishStatus> = {}): PublishStatus =>
    ({ job: "publish", phase: "idle", checkout: "~/x", readable: true, branch: "master", dirty: false, version: "1.0.400", masterVersion: "1.0.400", publishedVersion: "1.0.399", commits: [], notes: "", refusal: null, ...over }) as PublishStatus;

  it("shows only where the release folder holds a Docket checkout", () => {
    expect(publishable(status())).toBe(true);
    expect(publishable(status({ readable: false }))).toBe(false);
    expect(publishable(status({ version: null }))).toBe(false);
    expect(publishable(null)).toBe(false);
    // A Mac that never had a checkout has no Publish; one that had keeps the page when the folder is set wrong,
    // since the field that mends it is on the page.
    expect(publishShown(status({ readable: false }), false)).toBe(false);
    expect(publishShown(status({ readable: false }), true)).toBe(true);
    expect(publishShown(status(), false)).toBe(true);
    expect(publishShown(null, true)).toBe(false);
  });

  it("words a new release", () => {
    expect(newReleaseWords(status())).toBe("1.0.400 from master, last 1.0.399");
    expect(newReleaseWords(status({ dirty: true, branch: "fix" }))).toBe("1.0.400 from fix, last 1.0.399, with changes not committed");
    expect(newReleaseWords(status({ readable: false, refusal: null }))).toBe("~/x is not a Docket checkout");
  });
});
