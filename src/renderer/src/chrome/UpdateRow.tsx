import { ArrowDownCircle, FileText, RefreshCw, X } from "./icons";
import { Spinner } from "../components/ui/spinner";
import { isWebMode } from "../lib/nativeWeb";
import { canRetry, type UpdaterSnapshot } from "../lib/updater";
import { updateStore, useUpdateSnapshot } from "../lib/updateStore";
import type { InstalledUpdate } from "../lib/updateNotice";
import { useShell, shell } from "../stores/shell";
import { RailRow } from "./RailRow";

/** What the rail's update row says: always something in the desktop app. */
export type UpdateRowState =
  | { kind: "check"; version?: string }
  | { kind: "checking"; version?: string }
  | { kind: "updated"; version: string }
  | { kind: "available"; version: string; notes?: string; retry: boolean; error?: string }
  | { kind: "downloading"; percent: number }
  /** `subject`: a code-only update's commit, said on hover. */
  | { kind: "ready"; subject?: string };

/** A download in hand outranks one to start, which outranks the note that
 *  an update just landed; otherwise the row offers a check with the running
 *  version, and says Checking… while a check the person asked for runs
 *  (`manual`; the background probes keep the row still). */
export function updateRowState(snapshot: UpdaterSnapshot, notice: InstalledUpdate | null, manual = false): UpdateRowState {
  if (snapshot.phase === "ready") return snapshot.codeSubject ? { kind: "ready", subject: snapshot.codeSubject } : { kind: "ready" };
  if (snapshot.phase === "downloading") return { kind: "downloading", percent: snapshot.percent ?? 0 };
  const retry = canRetry(snapshot);
  if ((snapshot.phase === "available" || retry) && snapshot.availableVersion) {
    return { kind: "available", version: snapshot.availableVersion, notes: snapshot.notes, retry, error: retry ? snapshot.error : undefined };
  }
  if (notice) return { kind: "updated", version: notice.version };
  const version = /^\d/.test(snapshot.currentVersion) ? `v${snapshot.currentVersion}` : undefined;
  return { kind: snapshot.phase === "checking" && manual ? "checking" : "check", version };
}

/** The live state: the update store and the shell's "just updated" note;
 *  null at /ui, which has no updater. */
export function useUpdateRowState(): UpdateRowState | null {
  const snapshot = useUpdateSnapshot();
  const notice = useShell((s) => s.updateNotice);
  if (isWebMode()) return null;
  return updateRowState(snapshot, notice, updateStore.manualCheck);
}

const versioned = (label: string, version?: string) => (version ? `${label}, ${version}` : label);

/** The running version at the row's end; in a rail under 15rem (18rem with
 *  a staged commit's "+ 3f9c2ab") it yields to the label, which the row's
 *  name still pairs it with. */
function Version({ version }: { version?: string }) {
  if (!version) return null;
  return <span className={version.includes(" + ") ? "@max-[18rem]/railrow:hidden" : "@max-[15rem]/railrow:hidden"}>{version}</span>;
}

/**
 * The rail's update row, one RailRow: "Check for updates" with the running
 * version at its end (asks the feed), "Checking…" with the spinner while
 * that runs, "Updated to 1.0.N" (opens What's new, ✕ dismisses), "Update
 * to 1.0.N" or "Retry update" (installs; What's new as the hover action
 * when there are notes), "Downloading" with its percentage, "Restart to
 * update" (a code-only update names its commit on hover). The glyph is
 * the accent while there is something to do; there is no tinted fill.
 */
export function UpdateRow({
  state,
  onOpenWhatsNew,
  onInstall = () => void updateStore.install(),
  onCheck = () => void updateStore.check(true),
  onDismiss = shell.dismissUpdate,
}: {
  state: UpdateRowState | null;
  onOpenWhatsNew?: (version: string, markdown?: string) => void;
  onInstall?: () => void;
  onCheck?: () => void;
  onDismiss?: () => void;
}) {
  if (!state) return null;
  const label = (text: string) => <span className="text-foreground">{text}</span>;
  switch (state.kind) {
    case "check":
      return (
        <RailRow
          icon={RefreshCw}
          label="Check for updates"
          ariaLabel={versioned("Check for updates", state.version)}
          trailing={<Version version={state.version} />}
          onClick={onCheck}
          className="@container/railrow"
        />
      );
    case "checking":
      return (
        <RailRow
          glyph={<Spinner />}
          label="Checking…"
          ariaLabel={versioned("Checking…", state.version)}
          trailing={<Version version={state.version} />}
          disabled
          className="@container/railrow"
        />
      );
    case "updated":
      return (
        <RailRow
          icon={ArrowDownCircle}
          label={label(`Updated to ${state.version}`)}
          ariaLabel={`Updated to ${state.version}, what's new`}
          onClick={() => onOpenWhatsNew?.(state.version)}
          hoverActions={[{ label: "Dismiss", icon: X, onClick: onDismiss }]}
        />
      );
    case "available":
      return (
        <RailRow
          icon={ArrowDownCircle}
          glyphClassName="text-accent"
          label={label(state.retry ? "Retry update" : `Update to ${state.version}`)}
          tooltip={state.error}
          onClick={onInstall}
          hoverActions={
            state.notes && onOpenWhatsNew
              ? [{ label: "What's new", icon: FileText, onClick: () => onOpenWhatsNew(state.version, state.notes) }]
              : undefined
          }
        />
      );
    case "downloading":
      return <RailRow icon={ArrowDownCircle} label="Downloading" trailing={`${state.percent}%`} />;
    case "ready":
      return (
        <RailRow
          icon={ArrowDownCircle}
          glyphClassName="text-accent"
          label={label("Restart to update")}
          ariaLabel={state.subject ? versioned("Restart to update", state.subject) : undefined}
          tooltip={state.subject}
          onClick={onInstall}
        />
      );
  }
}
