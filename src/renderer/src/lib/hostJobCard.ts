import type { HostJob, HostJobStatus } from "@server/shared/contract-host";

/**
 * A deploy's or a publish's log state (Settings → Hosts: the log under a
 * box's Deploy row or This Mac's Publish row), pure so the states are testable: what the header says, which
 * lines show (the last TAIL_LINES), whether Stop is offered, and the
 * closing line once the job is done. The deploy job cannot be stopped once
 * the trigger has it and the card says so; the box restarting mid-deploy
 * drops the link, and the card says that too until the log goes on.
 */

export const TAIL_LINES = 40;

export type HostJobCard = {
  /** Idle: nothing to show. */
  visible: boolean;
  phase: HostJobStatus["phase"];
  title: string;
  /** The quiet line beside the title, or null. */
  note: string | null;
  lines: string[];
  stoppable: boolean;
  /** The closing line once done, and whether it is a failure. */
  ending: { text: string; failed: boolean } | null;
};

export type HostJobCardInput = {
  job: HostJob;
  status: HostJobStatus;
  text: string;
  /** The host the job runs on, as the row names it. */
  hostName: string;
  /** The socket to that host is open right now. */
  linkUp: boolean;
  /** The version the host reports after the deploy (its new build), when known. */
  deployedVersion?: string | null;
};

export function tailLines(text: string, count = TAIL_LINES): string[] {
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.length > count ? lines.slice(lines.length - count) : lines;
}

const versionText = (v: string | null | undefined): string | null => (v ? (v.startsWith("v") ? v : `v${v}`) : null);

export function hostJobCard(input: HostJobCardInput): HostJobCard {
  const { job, status, text, hostName, linkUp } = input;
  const lines = tailLines(text);
  const target = status.target;
  if (status.phase === "idle") {
    return { visible: false, phase: "idle", title: "", note: null, lines, stoppable: false, ending: null };
  }
  if (job === "deploy") {
    // The branch a deploy builds is the builder's word; he reads "Updating the box".
    const to = target && target !== "master" ? ` to ${target}` : "";
    if (status.phase === "pending") {
      return { visible: true, phase: "pending", title: `Updating ${hostName}${to}`, note: `Waiting for ${hostName} to start`, lines, stoppable: false, ending: null };
    }
    if (status.phase === "running") {
      const note = linkUp ? `Cannot be stopped part-way. ${hostName} goes back to the build it had if this fails.` : `${hostName} is restarting. The log goes on when it is back.`;
      return { visible: true, phase: "running", title: `Updating ${hostName}${to}`, note, lines, stoppable: false, ending: null };
    }
    if (status.exit === 0) {
      const version = versionText(input.deployedVersion);
      return { visible: true, phase: "done", title: `Updated ${hostName}${to}`, note: null, lines, stoppable: false, ending: { text: version ? `${hostName} runs ${version} and is back` : `${hostName} is updated and back`, failed: false } };
    }
    const text = status.exit === null ? "The update did not start" : `The update failed (exit ${status.exit})`;
    return { visible: true, phase: "done", title: `Update of ${hostName}${to}`, note: null, lines, stoppable: false, ending: { text, failed: true } };
  }
  const version = versionText(target) ?? "the Mac release";
  if (status.phase === "pending" || status.phase === "running") {
    return { visible: true, phase: status.phase, title: `Publishing ${version}`, note: "Signing, notarizing and uploading from this Mac", lines, stoppable: status.stoppable, ending: null };
  }
  if (status.exit === 0) {
    return { visible: true, phase: "done", title: `Published ${version}`, note: null, lines, stoppable: false, ending: { text: `Published ${version}; the installed app offers it on its next check`, failed: false } };
  }
  const stopped = status.exit === 143 || status.exit === 137;
  return {
    visible: true,
    phase: "done",
    title: stopped ? `Publish of ${version} stopped` : `Publish of ${version} failed`,
    note: null,
    lines,
    stoppable: false,
    ending: { text: stopped ? "Stopped; nothing was published" : `Publish failed (exit ${status.exit ?? "?"})`, failed: true },
  };
}

const releaseN = (version: string | null | undefined): number | null => {
  const m = version?.match(/^v?1\.0\.(\d+)$/);
  return m ? Number(m[1]) : null;
};

/** The deploy confirm's body: the versions, and how many releases lie between them. */
export function deployConfirmText(hostName: string, deployed: string | null, master: string | null): string {
  const from = versionText(deployed);
  const to = versionText(master);
  const a = releaseN(deployed);
  const b = releaseN(master);
  if (from && to && a !== null && b !== null) {
    const n = b - a;
    if (n > 0) return `${from} → ${to}, ${n} ${n === 1 ? "release" : "releases"}. ${hostName} builds the newest release, tries it and restarts. It goes back if the try fails.`;
    if (n === 0) return `${hostName} already runs ${to}. Updating builds it again and restarts ${hostName} anyway.`;
    return `${hostName} runs ${from}, which is newer than the newest release, ${to}. Updating builds ${to} and restarts ${hostName}.`;
  }
  if (from) return `${hostName} runs ${from}. Updating builds the newest release, tries it and restarts ${hostName}.`;
  return `${hostName} builds the newest release, tries it and restarts. It goes back if the try fails.`;
}

/**
 * What a box's Deploy row says, as separate facts: the version it runs, and
 * whether an update runs now or it is up to date. How many releases behind
 * is the host header's `+N`; a host not connected says nothing here (its
 * header says it).
 */
export function deployRowParts(opts: { installed: boolean; version: string | null; masterVersion: string | null; connected: boolean; phase: HostJobStatus["phase"] }): string[] {
  if (!opts.connected) return [];
  if (!opts.installed) return ["This computer cannot be updated from here"];
  const runs = `Runs ${versionText(opts.version) ?? "an unknown version"}`;
  if (opts.phase === "pending" || opts.phase === "running") return [runs, "updating"];
  const a = releaseN(opts.version);
  const b = releaseN(opts.masterVersion);
  return a !== null && b !== null && b <= a ? [runs, "up to date"] : [runs];
}
