import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  announce: vi.fn(),
  apply: vi.fn(),
  ask: vi.fn(),
  check: vi.fn(),
  get: vi.fn(),
  message: vi.fn(),
  onStatus: vi.fn(),
  remember: vi.fn(),
}));

vi.mock("./native", () => ({
  ask: mocks.ask,
  message: mocks.message,
  updates: {
    get: mocks.get,
    check: mocks.check,
    apply: mocks.apply,
    onStatus: mocks.onStatus,
  },
}));
vi.mock("./sounds", () => ({ announceUpdateAvailable: mocks.announce }));
vi.mock("./updateNotice", () => ({ rememberInstalledUpdate: mocks.remember }));

const status = (over: Record<string, unknown> = {}) => ({
  current: "1.0.198",
  latest: "1.0.199",
  notes: "Notes",
  canApply: true,
  checked: true,
  phase: "idle",
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  mocks.message.mockResolvedValue(undefined);
  mocks.get.mockResolvedValue(status());
});

describe("snapshotFromStatus", () => {
  it("maps the feed's phases onto the renderer's", async () => {
    const { snapshotFromStatus } = await import("./updater");
    expect(snapshotFromStatus(status())).toMatchObject({
      phase: "available",
      currentVersion: "1.0.198",
      availableVersion: "1.0.199",
      notes: "Notes",
    });
    expect(snapshotFromStatus(status({ latest: null })).phase).toBe("current");
    expect(snapshotFromStatus(status({ latest: null, checked: false })).phase).toBe("idle");
    expect(snapshotFromStatus(status({ phase: "downloading", percent: 42 }))).toMatchObject({
      phase: "downloading",
      percent: 42,
      availableVersion: "1.0.199",
    });
    expect(snapshotFromStatus(status({ phase: "ready" })).phase).toBe("ready");
    expect(snapshotFromStatus(status({ phase: "error", error: "offline" }))).toMatchObject({
      phase: "error",
      error: "offline",
    });
  });

  it("shows an install that never landed as a retryable error", async () => {
    const { canRetry, snapshotFromStatus } = await import("./updater");
    const failure = { version: "1.0.199", reason: "The downloaded update failed its signature check." };
    const snapshot = snapshotFromStatus(status({ installFailure: failure }));
    expect(snapshot).toMatchObject({
      phase: "error",
      availableVersion: "1.0.199",
      error: failure.reason,
    });
    expect(canRetry(snapshot)).toBe(true);
    // The feed has not answered yet: the attempted version still names the retry.
    expect(snapshotFromStatus(status({ installFailure: failure, latest: null, checked: false })).availableVersion).toBe(
      "1.0.199",
    );
    // A download in progress or a plain feed error without a version is not a retry.
    expect(snapshotFromStatus(status({ installFailure: failure, phase: "downloading" })).phase).toBe("downloading");
    expect(canRetry(snapshotFromStatus(status({ phase: "error", error: "offline", latest: null })))).toBe(false);
    expect(canRetry(snapshotFromStatus(status({ installFailure: failure, canApply: false })))).toBe(false);
  });
});

describe("snapshotFromStatus with code-only updates", () => {
  const commit = "3f9c2ab0e1d2c3b4a5968778695a4b3c2d1e0f9a";
  const offer = (phase: "downloading" | "ready", percent?: number) => ({
    offer: { commit, release: 372, subject: "Fix the rail's spacing. Then more words.\n\nBody", phase, percent },
  });

  it("says the version with the staged code's commit, or alone", async () => {
    const { snapshotFromStatus } = await import("./updater");
    expect(snapshotFromStatus(status({ latest: null })).currentVersion).toBe("1.0.198");
    const running = { running: { commit, release: 371, subject: "s" } };
    expect(snapshotFromStatus(status({ latest: null, code: running })).currentVersion).toBe("1.0.198 + 3f9c2ab");
    expect(snapshotFromStatus(status({ code: { ...running, ...offer("ready") } })).currentVersion).toBe("1.0.198 + 3f9c2ab");
  });

  it("puts a downloaded or downloading release first", async () => {
    const { snapshotFromStatus } = await import("./updater");
    const ready = snapshotFromStatus(status({ phase: "ready", code: offer("ready") }));
    expect(ready).toMatchObject({ phase: "ready", availableVersion: "1.0.199" });
    expect(ready.codeSubject).toBeUndefined();
    const downloading = snapshotFromStatus(status({ phase: "downloading", percent: 10, code: offer("ready") }));
    expect(downloading).toMatchObject({ phase: "downloading", percent: 10, availableVersion: "1.0.199" });
  });

  it("puts a code offer in hand over a release merely available or a failed install, with no release version", async () => {
    const { snapshotFromStatus } = await import("./updater");
    const ready = snapshotFromStatus(status({ code: offer("ready") }));
    expect(ready).toEqual({ phase: "ready", currentVersion: "1.0.198", codeSubject: "Fix the rail's spacing", canApply: true });
    const failure = { version: "1.0.199", reason: "The signature did not match." };
    expect(snapshotFromStatus(status({ installFailure: failure, code: offer("ready") })).phase).toBe("ready");
    expect(snapshotFromStatus(status({ phase: "error", error: "offline", code: offer("ready") })).phase).toBe("ready");
    expect(snapshotFromStatus(status({ phase: "checking", code: offer("ready") })).phase).toBe("ready");
  });

  it("maps a code download onto downloading with its percent", async () => {
    const { snapshotFromStatus } = await import("./updater");
    const snapshot = snapshotFromStatus(status({ latest: null, code: offer("downloading", 37) }));
    expect(snapshot).toMatchObject({ phase: "downloading", percent: 37, codeSubject: "Fix the rail's spacing" });
    expect(snapshot.availableVersion).toBeUndefined();
    expect(snapshotFromStatus(status({ latest: null, code: offer("downloading") })).percent).toBe(0);
  });

  it("names a subjectless offer by its commit", async () => {
    const { snapshotFromStatus } = await import("./updater");
    const snapshot = snapshotFromStatus(status({ code: { offer: { commit, release: 372, subject: "", phase: "ready" } } }));
    expect(snapshot.codeSubject).toBe("3f9c2ab");
  });

  it("carries main's notice on every phase", async () => {
    const { snapshotFromStatus } = await import("./updater");
    const notice = "Code update 3f9c2ab did not start. Running 1.0.198.";
    expect(snapshotFromStatus(status({ latest: null, code: { notice } })).notice).toBe(notice);
    expect(snapshotFromStatus(status({ code: { notice, ...offer("ready") } })).notice).toBe(notice);
    expect(snapshotFromStatus(status({ latest: null, code: { notice: "" } })).notice).toBeUndefined();
  });
});

describe("firstSaying", () => {
  it("is true once per distinct non-empty line", async () => {
    const { firstSaying } = await import("./updater");
    const said = new Set<string>();
    expect(firstSaying(said, undefined)).toBe(false);
    expect(firstSaying(said, "")).toBe(false);
    expect(firstSaying(said, "Code update 3f9c2ab did not start. Running 1.0.198.")).toBe(true);
    expect(firstSaying(said, "Code update 3f9c2ab did not start. Running 1.0.198.")).toBe(false);
    expect(firstSaying(said, "Code update 4a0b1c2 needs a full release: node_modules changed.")).toBe(true);
    expect(firstSaying(said, "Code update 3f9c2ab did not start. Running 1.0.198.")).toBe(false);
  });
});

describe("installPendingUpdate", () => {
  it("restarts into a staged code update and records no release for the notice", async () => {
    const code = { offer: { commit: "3f9c2ab0", release: 372, subject: "Fix it", phase: "ready" } };
    mocks.get.mockResolvedValue(status({ latest: null, code }));
    mocks.apply.mockResolvedValue(status({ latest: null, code }));
    const { installPendingUpdate } = await import("./updater");

    const result = await installPendingUpdate();

    expect(mocks.apply).toHaveBeenCalledOnce();
    expect(mocks.remember).not.toHaveBeenCalled();
    expect(result.phase).toBe("ready");
  });

  it("starts the download and reports it", async () => {
    mocks.apply.mockResolvedValue(status({ phase: "downloading", percent: 0 }));
    const { installPendingUpdate } = await import("./updater");
    const seen: string[] = [];

    const result = await installPendingUpdate((s) => seen.push(s.phase));

    expect(mocks.apply).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ phase: "downloading", percent: 0 });
    expect(seen).toEqual(["downloading"]);
    expect(mocks.message).not.toHaveBeenCalled();
  });

  it("restarts into a downloaded release and remembers it for the notice", async () => {
    mocks.get.mockResolvedValue(status({ phase: "ready" }));
    mocks.apply.mockResolvedValue(status({ phase: "ready" }));
    const { installPendingUpdate } = await import("./updater");

    await installPendingUpdate();

    expect(mocks.remember).toHaveBeenCalledWith("1.0.199");
    expect(mocks.apply).toHaveBeenCalledOnce();
  });

  it("retries a failed install through apply", async () => {
    const failure = { version: "1.0.199", reason: "The app was still running when the update tried to install." };
    mocks.get.mockResolvedValue(status({ installFailure: failure }));
    mocks.apply.mockResolvedValue(status({ phase: "downloading", percent: 0 }));
    const { installPendingUpdate } = await import("./updater");

    const result = await installPendingUpdate();

    expect(mocks.apply).toHaveBeenCalledOnce();
    expect(result.phase).toBe("downloading");
  });

  it("refuses in a dev instance that cannot apply", async () => {
    mocks.get.mockResolvedValue(status({ canApply: false }));
    const { installPendingUpdate } = await import("./updater");

    const result = await installPendingUpdate();

    expect(mocks.apply).not.toHaveBeenCalled();
    expect(result.phase).toBe("error");
    expect(mocks.message).toHaveBeenCalledOnce();
  });

  it("reports a download that did not start", async () => {
    mocks.apply.mockResolvedValue(status());
    const { installPendingUpdate } = await import("./updater");

    const result = await installPendingUpdate();

    expect(result).toMatchObject({ phase: "error", error: "The download did not start." });
  });
});

describe("runUpdateFlow", () => {
  it("announces an available release on an automatic check and stops there", async () => {
    mocks.check.mockResolvedValue(status());
    const { runUpdateFlow } = await import("./updater");

    const result = await runUpdateFlow(false);

    expect(result.phase).toBe("available");
    expect(mocks.announce).toHaveBeenCalledWith("1.0.199");
    expect(mocks.ask).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("asks before downloading on a manual check", async () => {
    mocks.check.mockResolvedValue(status());
    mocks.ask.mockResolvedValue(true);
    mocks.apply.mockResolvedValue(status({ phase: "downloading", percent: 0 }));
    const { runUpdateFlow } = await import("./updater");

    const result = await runUpdateFlow(true);

    expect(mocks.ask).toHaveBeenCalledOnce();
    expect(mocks.ask.mock.calls[0][0]).toContain("Download it now?");
    expect(result.phase).toBe("downloading");
  });

  it("offers to download a release again after a failed install, on a manual check", async () => {
    const failure = { version: "1.0.199", reason: "The downloaded update failed its signature check." };
    mocks.check.mockResolvedValue(status({ installFailure: failure }));
    mocks.ask.mockResolvedValue(true);
    mocks.get.mockResolvedValue(status({ installFailure: failure }));
    mocks.apply.mockResolvedValue(status({ phase: "downloading", percent: 0 }));
    const { runUpdateFlow } = await import("./updater");

    const result = await runUpdateFlow(true);

    expect(mocks.ask.mock.calls[0][0]).toContain("did not install");
    expect(mocks.apply).toHaveBeenCalledOnce();
    expect(result.phase).toBe("downloading");

    mocks.apply.mockClear();
    expect((await runUpdateFlow(false)).phase).toBe("error");
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("says so when current, only on a manual check", async () => {
    mocks.check.mockResolvedValue(status({ latest: null }));
    const { runUpdateFlow } = await import("./updater");

    await runUpdateFlow(false);
    expect(mocks.message).not.toHaveBeenCalled();
    await runUpdateFlow(true);
    expect(mocks.message).toHaveBeenCalledWith("You're on the latest release.", { title: "TempCode" });
  });

  it("leaves a running download alone", async () => {
    mocks.get.mockResolvedValue(status({ phase: "downloading", percent: 50 }));
    const { runUpdateFlow } = await import("./updater");

    const result = await runUpdateFlow(true);

    expect(mocks.check).not.toHaveBeenCalled();
    expect(result).toMatchObject({ phase: "downloading", percent: 50 });
  });
});

describe("watchUpdateStatus", () => {
  it("remembers the downloaded version once for the post-restart notice", async () => {
    const { watchUpdateStatus } = await import("./updater");
    const seen: string[] = [];
    watchUpdateStatus((s) => seen.push(s.phase));
    const push = mocks.onStatus.mock.calls[0][0] as (s: unknown) => void;

    push(status({ phase: "downloading", percent: 10 }));
    push(status({ phase: "ready" }));
    push(status({ phase: "ready" }));

    expect(seen).toEqual(["downloading", "ready", "ready"]);
    expect(mocks.remember).toHaveBeenCalledTimes(1);
    expect(mocks.remember).toHaveBeenCalledWith("1.0.199");
  });

  it("never records a code-only update as an installed release", async () => {
    const { watchUpdateStatus } = await import("./updater");
    const seen: string[] = [];
    watchUpdateStatus((s) => seen.push(s.phase));
    const push = mocks.onStatus.mock.calls[0][0] as (s: unknown) => void;

    push(status({ code: { offer: { commit: "3f9c2ab0", release: 372, subject: "Fix it", phase: "ready" } } }));

    expect(seen).toEqual(["ready"]);
    expect(mocks.remember).not.toHaveBeenCalled();
  });
});
