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

const { SyncLine, SyncPage, conflictWords, memoryWords, namesWords, syncedWords } = await import("./SyncPage");
let stops = 0;
vi.mock("../../../lib/hostJobs", async (original) => ({
  ...(await original<typeof import("../../../lib/hostJobs")>()),
  watchJob: () => {},
  stopPublish: async () => void stops++,
}));
const { PublishPage, newReleaseWords, publishable, publishShown } = await import("./PublishPage");

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
    // The page's line names the computers; the row does not say them again.
    expect(screen.getByText("This Mac's Claude Code and Codex settings. 2 files stay here.")).toBeTruthy();
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

  it("keeps Agents' memory in view: bones while its own read is out, its failure with Retry, absent only without memory sync", async () => {
    answers["memory.status"] = () => new Promise(() => {});
    render(<SyncPage />);
    await act(async () => {});
    const waiting = document.querySelector("[data-setting='sync.memory']")!;
    expect(waiting.textContent).toContain("Agents' memory");
    expect(waiting.querySelector("[data-skeleton-control]")).not.toBeNull();
    expect(screen.getByLabelText("Agent settings")).toBeTruthy();
    cleanup();
    // Refused: the row stays, says so, and its Retry reads again.
    answers["memory.status"] = () => Promise.reject(new Error("The computer did not answer"));
    render(<SyncPage />);
    await act(async () => {});
    await act(async () => {});
    const failed = document.querySelector("[data-setting='sync.memory']")!;
    expect(failed.textContent).toContain("did not answer.");
    answers["memory.status"] = { enabled: true, skipped: 0, environments: [], conflicts: [] };
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry" })));
    await act(async () => {});
    expect(screen.getByLabelText("Agents' memory")).toBeTruthy();
    cleanup();
    // A server from before memory sync: no row at all.
    answers["memory.status"] = () => Promise.reject(new Error("unknown method memory.status"));
    render(<SyncPage />);
    await act(async () => {});
    await act(async () => {});
    expect(document.querySelector("[data-setting='sync.memory']")).toBeNull();
  });

  it("hides Agents' memory only for an unknown method: a bad request is said with Retry", async () => {
    answers["memory.status"] = () => Promise.reject(new Error("bad request"));
    render(<SyncPage />);
    await act(async () => {});
    await act(async () => {});
    expect(document.querySelector("[data-setting='sync.memory']")?.textContent).toContain("Bad request");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("claims nothing about memory in Last synced while its read is out or failed and the agent settings are off", async () => {
    answers["memory.status"] = () => new Promise(() => {});
    render(<SyncPage />);
    await act(async () => {});
    const rows = [...document.querySelectorAll("[data-synced]")];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.textContent).not.toContain("Nothing syncs");
      expect(row.querySelector("[data-slot=skeleton]")).not.toBeNull();
    }
    cleanup();
    answers["memory.status"] = () => Promise.reject(new Error("The computer did not answer"));
    render(<SyncPage />);
    await act(async () => {});
    await act(async () => {});
    for (const row of document.querySelectorAll("[data-synced]")) {
      expect(row.textContent).not.toContain("Nothing syncs");
      expect(row.textContent).not.toContain("Never synced");
    }
  });

  it("counts the computers the memory is kept the same on", () => {
    expect(memoryWords(2)).toBe("Kept the same both ways.");
    expect(memoryWords(3)).toBe("Kept the same on all three, both ways.");
  });

  it("says a computer's last sync as one sentence, the conflict copies in plain words", () => {
    const now = 1_000_000;
    const leg = { id: "b", name: "The box", connected: true, running: false, sets: null, lastAttemptAt: null, error: null };
    expect(syncedWords({ ...leg, files: 212, syncedAt: now - 120_000 }, { ...leg, files: 48, syncedAt: now - 60_000, conflicts: 1 }, now)).toEqual({
      words: "212 agent settings files and 48 memory files, synced 1m ago",
      error: null,
    });
    expect(syncedWords(null, { ...leg, files: 1, syncedAt: null, conflicts: 0 }, now).words).toBe("Never synced");
    expect(syncedWords({ ...leg, files: 3, syncedAt: now, running: true }, null, now).words).toBe("Syncing…");
    expect(conflictWords(1)).toBe("1 note differs. Both copies are kept.");
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
    expect(newReleaseWords(status())).toBe("1.0.400, last published 1.0.399");
    expect(newReleaseWords(status({ dirty: true, branch: "fix" }))).toBe("1.0.400, last published 1.0.399, from a side branch, with changes not committed");
    expect(newReleaseWords(status({ readable: false, refusal: null }))).toBe("~/x is not a Docket checkout");
  });

  it("stands in its shape while it reads, and a failed read is one line with Retry and no field", async () => {
    answers["host.publishStatus"] = () => new Promise(() => {});
    const { container, unmount } = render(<PublishPage />);
    expect(container.querySelectorAll("[data-slot=page-row-skeleton]")).toHaveLength(2);
    expect(screen.queryByLabelText("Release folder")).toBeNull();
    unmount();
    answers["host.publishStatus"] = () => Promise.reject(new Error("The computer did not answer"));
    render(<PublishPage />);
    await flush();
    expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(1);
    expect(screen.queryByLabelText("Release folder")).toBeNull();
    expect(screen.queryByText("Publish…")).toBeNull();
  });

  it("says a running publish on its row, whose press is Stop…, which asks first", async () => {
    answers["host.publishStatus"] = status({ phase: "running", target: "1.0.400", stoppable: true } as Partial<PublishStatus>);
    render(<PublishPage />);
    await flush();
    expect(screen.getByText("Publishing 1.0.400…")).toBeTruthy();
    expect(screen.queryByText("Publish…")).toBeNull();
    answer = false;
    fireEvent.click(screen.getByText("Stop…"));
    await flush();
    expect(confirms.at(-1)).toEqual(expect.objectContaining({ title: "Stop the publish?", body: "The release is left half made." }));
    expect(stops).toBe(0);
  });

  it("leaves what runs to the log's own line once the log is drawn, keeping Stop… on the row", async () => {
    const { hostJobsStore } = await import("../../../lib/hostJobs");
    const running = { job: "publish", phase: "running", target: "1.0.400", startedAt: 1, finishedAt: null, exit: null, stoppable: true };
    hostJobsStore.setState({ jobs: { "local:publish": { environmentId: "local", job: "publish", status: running, text: "Signing Docket.app\n" } } } as never);
    answers["host.publishStatus"] = status({ phase: "running", target: "1.0.400", stoppable: true } as Partial<PublishStatus>);
    render(<PublishPage />);
    await flush();
    expect(document.querySelector("[data-setting='publish.new']")?.textContent).not.toContain("Publishing 1.0.400…");
    expect(screen.getByText("Stop…")).toBeTruthy();
    hostJobsStore.setState({ jobs: {} } as never);
  });
});
