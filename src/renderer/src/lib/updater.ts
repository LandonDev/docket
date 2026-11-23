import { shortSubject, versionLine } from "@server/shared/codeUpdate";
import { ask, message, updates, type UpdateStatus } from "./native";
import { announceUpdateAvailable } from "./sounds";
import { rememberInstalledUpdate } from "./updateNotice";

/**
 * The update flow on top of main's electron-updater: releases are semver
 * (1.0.N) on the GitHub feed; `apply` downloads a waiting release, and once
 * it is downloaded `apply` again restarts into it. The renderer only
 * mirrors status and asks the user.
 */

export type UpdaterPhase =
  | "idle"
  | "checking"
  | "current"
  | "available"
  | "downloading"
  | "ready"
  | "error";

export type UpdaterSnapshot = {
  phase: UpdaterPhase;
  /** The version as the app says it: "1.0.371", or "1.0.371 + 3f9c2ab" on staged code. */
  currentVersion: string;
  /** A release's version; never set for a code-only update. */
  availableVersion?: string;
  /** A code-only update on its way or ready: its commit's subject, cut short. */
  codeSubject?: string;
  /** Main's one line about code-only updates (a fallback, a refusal). */
  notice?: string;
  /** Release notes for the waiting update, shown before installing. */
  notes?: string;
  /** While downloading: whole percent. */
  percent?: number;
  /** Dev instances mirror status but only the installed app applies. */
  canApply?: boolean;
  error?: string;
};

/** The hand-built installer, for when the updater cannot finish on its own. */
export const MANUAL_DOWNLOAD_URL =
  "https://github.com/LandonDev/temp-code/releases/latest/download/TempCode-arm64.dmg";

/** An error with a version to retry: the button downloads it again. */
export function canRetry(snapshot: UpdaterSnapshot): boolean {
  return (
    snapshot.phase === "error" &&
    !!snapshot.availableVersion &&
    snapshot.canApply === true
  );
}

export function snapshotFromStatus(status: UpdateStatus): UpdaterSnapshot {
  const snapshot = releaseSnapshot(status);
  const notice = status.code?.notice || undefined;
  const offer = status.code?.offer;
  // A release downloaded or downloading goes first; a code offer in hand
  // outranks the rest (a release merely available, a failed install).
  if (offer && status.phase !== "ready" && status.phase !== "downloading") {
    return {
      phase: offer.phase,
      currentVersion: snapshot.currentVersion,
      codeSubject: shortSubject(offer.subject) || offer.commit.slice(0, 7),
      ...(offer.phase === "downloading" ? { percent: offer.percent ?? 0 } : {}),
      canApply: status.canApply,
      notice,
    };
  }
  return notice ? { ...snapshot, notice } : snapshot;
}

function releaseSnapshot(status: UpdateStatus): UpdaterSnapshot {
  const currentVersion = versionLine(status.current, status.code?.running?.commit);
  const availableVersion = status.latest ?? undefined;
  const canApply = status.canApply;
  // A release handed to the installer that never landed outranks a quiet
  // idle: the user sees why and the same button retries.
  if (
    status.installFailure &&
    (status.phase === "idle" || status.phase === "checking")
  ) {
    return {
      phase: "error",
      currentVersion,
      availableVersion: availableVersion ?? status.installFailure.version,
      error: status.installFailure.reason,
      canApply,
    };
  }
  switch (status.phase) {
    case "checking":
      return { phase: "checking", currentVersion, canApply };
    case "downloading":
      return {
        phase: "downloading",
        currentVersion,
        availableVersion,
        percent: status.percent ?? 0,
        canApply,
      };
    case "ready":
      return { phase: "ready", currentVersion, availableVersion, canApply };
    case "error":
      return {
        phase: "error",
        currentVersion,
        availableVersion,
        error: status.error ?? "Update failed.",
        canApply,
      };
    case "idle":
      if (availableVersion) {
        return {
          phase: "available",
          currentVersion,
          availableVersion,
          notes: status.notes.trim() || undefined,
          canApply,
        };
      }
      return {
        phase: status.checked ? "current" : "idle",
        currentVersion,
        canApply,
      };
  }
}

/** A notice is said once per distinct line per launch: true, and kept in
 *  `said`, the first time a non-empty line arrives; false for it after. */
export function firstSaying(said: Set<string>, line: string | undefined): line is string {
  if (!line || said.has(line)) return false;
  said.add(line);
  return true;
}

const busy = (phase: UpdaterPhase) =>
  phase === "downloading" || phase === "ready";

let remembered: string | undefined;

/** Mirror main's status stream. Once a download is ready the restart lands
 *  in the new release, whose first boot shows these notes. */
export function watchUpdateStatus(
  onSnapshot: (snapshot: UpdaterSnapshot) => void,
): () => void {
  return updates.onStatus((status) => {
    const snapshot = snapshotFromStatus(status);
    if (
      snapshot.phase === "ready" &&
      snapshot.availableVersion &&
      remembered !== snapshot.availableVersion
    ) {
      remembered = snapshot.availableVersion;
      rememberInstalledUpdate(snapshot.availableVersion);
    }
    onSnapshot(snapshot);
  });
}

export async function runUpdateFlow(
  manual: boolean,
  onProgress?: (snapshot: UpdaterSnapshot) => void,
): Promise<UpdaterSnapshot> {
  const before = snapshotFromStatus(await updates.get());
  if (busy(before.phase)) {
    onProgress?.(before);
    return before;
  }
  onProgress?.({ phase: "checking", currentVersion: before.currentVersion });

  let snapshot: UpdaterSnapshot;
  try {
    snapshot = snapshotFromStatus(await updates.check());
  } catch (err) {
    snapshot = {
      phase: "error",
      currentVersion: before.currentVersion,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  onProgress?.(snapshot);

  if (snapshot.phase === "available") {
    announceUpdateAvailable(snapshot.availableVersion!);
    if (!manual) return snapshot;
    const detail = snapshot.notes ? `\n\n${snapshot.notes}` : "";
    const yes = await ask(
      `Release ${snapshot.availableVersion} is available (you have ${snapshot.currentVersion}).${detail}\n\nDownload it now?`,
      { title: "Update available", kind: "info" },
    );
    return yes ? installPendingUpdate(onProgress) : snapshot;
  }
  if (manual && canRetry(snapshot)) {
    const yes = await ask(
      `Release ${snapshot.availableVersion} did not install. ${snapshot.error}\n\nDownload it again?`,
      { title: "Update failed", kind: "warning", okLabel: "Download" },
    );
    return yes ? installPendingUpdate(onProgress) : snapshot;
  }
  if (manual && snapshot.phase === "error") {
    await message(`Couldn't check for updates.\n\n${snapshot.error}`, {
      title: "TempCode",
    });
  } else if (manual && snapshot.phase !== "idle") {
    await message("You're on the latest release.", { title: "TempCode" });
  }
  return snapshot;
}

/** Download the waiting release, or restart into one already downloaded.
 *  Progress then arrives on the status stream. */
export async function installPendingUpdate(
  onProgress?: (snapshot: UpdaterSnapshot) => void,
): Promise<UpdaterSnapshot> {
  const status = await updates.get();
  const snapshot = snapshotFromStatus(status);
  if (snapshot.phase === "ready") {
    if (snapshot.availableVersion) rememberInstalledUpdate(snapshot.availableVersion);
    const restarting = snapshotFromStatus(await updates.apply());
    onProgress?.(restarting);
    return restarting;
  }
  if (snapshot.phase !== "available" && !canRetry(snapshot)) {
    onProgress?.(snapshot);
    return snapshot;
  }
  if (!status.canApply) {
    const failed: UpdaterSnapshot = {
      ...snapshot,
      phase: "error",
      error: "This dev instance can't apply updates. Use the installed app.",
    };
    onProgress?.(failed);
    await message(failed.error!, { title: "TempCode" });
    return failed;
  }
  const started = snapshotFromStatus(await updates.apply());
  const result: UpdaterSnapshot = busy(started.phase)
    ? started
    : started.phase === "error"
      ? started
      : { ...snapshot, phase: "error", error: "The download did not start." };
  onProgress?.(result);
  if (result.phase === "error") {
    await message(`Couldn't download the update.\n\n${result.error}`, {
      title: "TempCode",
    });
  }
  return result;
}
