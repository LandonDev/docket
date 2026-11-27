import { dialogErrorWords } from "../lib/dialogErrorWords";
import { registry } from "../lib/connection";
import { environmentOfCwd } from "../lib/tcserver/projects";
import { ChevronDown, GitBranch } from "./icons";
import { ROW_CONTROL } from "./composerRow";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  gitCheckout,
  gitCommit,
  gitCreateBranch,
  gitStageAll,
  gitStash,
  isCheckoutBlockedByChanges,
  notifyGitChanged,
} from "../lib/fs";
import { useProjectBranchesState } from "../hooks/useProjectBranches";
import { Region } from "../components/bones";
import { TruncateTip } from "../components/tip";
import { Button } from "../components/ui/button";
import { cn } from "../lib/cn";
import { LazyPopover } from "./menuRows";
import type { BranchRow as Row, BranchRows } from "./BranchRows";
import { dialogsChunk, menuChunk } from "../surfaces/chunks";

// Mounted only while a switch is blocked, through the dialogs chunk.
const SwitchBranchDialog = dialogsChunk.surface("SwitchBranchDialog");

type Props = {
  cwd: string;
  branch?: string;
  enabled?: boolean;
  /** `composer`: the draft row's chip. `head`: the Changes section's branch
   *  name, in its 13px medium type, the list opening below it. */
  variant?: "composer" | "head";
  /** A label on hover (the head's Tracks / Not published / No remote). */
  tip?: string;
  onChange?: () => void;
  onClose?: () => void;
  /** The thread's type works on a branch. False (a chat or research draft): a folder with no repo draws nothing, not a dead "No repo". */
  needsRepo?: boolean;
};


type PendingSwitch =
  | { kind: "create"; name: string }
  | { kind: "checkout"; name: string; remote: string | null };

export function BranchPicker({
  cwd,
  branch,
  enabled = true,
  variant = "composer",
  tip,
  onChange,
  onClose,
  needsRepo = true,
}: Props) {
  const head = variant === "head";
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<PendingSwitch | null>(null);
  const [blockedError, setBlockedError] = useState<string | null>(null);
  const [blockedBusy, setBlockedBusy] = useState<"stash" | "commit" | null>(
    null,
  );
  const search = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const environmentId = environmentOfCwd(cwd) ?? registry.primary().environmentId;
  const inProject = Boolean(cwd) && cwd !== "~";
  // A hidden or busy composer keeps the branch it knows and asks git for
  // nothing; only the live one looks up the list.
  const { branches: projectBranches, settled: branchesSettled } =
    useProjectBranchesState(cwd, inProject && enabled);

  const current = branch || projectBranches?.current || null;
  const detached = !branch && !!projectBranches?.detached;

  const dismiss = (restore: boolean) => {
    setOpen(false);
    setQuery("");
    setError(null);
    setBusy(false);
    setBlocked(null);
    setBlockedError(null);
    setBlockedBusy(null);
    if (restore) onCloseRef.current?.();
  };

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setError(null);
  }, [open]);

  useEffect(() => {
    if (enabled) return;
    setOpen(false);
    setQuery("");
    setError(null);
    setBusy(false);
    setBlocked(null);
    setBlockedError(null);
    setBlockedBusy(null);
  }, [enabled]);

  const rows = useMemo((): Row[] => {
    const branches = projectBranches?.branches ?? [];
    const name = query.trim();
    const needle = name.toLowerCase();
    const filtered = needle
      ? branches.filter((entry) => {
          const hay = entry.remote
            ? `${entry.name} ${entry.remote}`
            : entry.name;
          return hay.toLowerCase().includes(needle);
        })
      : branches;
    const taken = branches.some(
      (entry) => !entry.remote && entry.name === name,
    );
    const selected = branch || projectBranches?.current;
    const create: Row[] =
      name && !taken ? [{ kind: "create", name }] : [];
    return [
      ...create,
      ...filtered.map((entry) => ({
        kind: "branch" as const,
        branch: {
          ...entry,
          current: entry.name === selected && !entry.remote,
        },
      })),
    ];
  }, [branch, projectBranches, query]);

  const applySwitch = (pending: PendingSwitch) =>
    pending.kind === "create"
      ? gitCreateBranch(environmentId, cwd, pending.name)
      : gitCheckout(environmentId, cwd, pending.name, pending.remote);

  const finishSwitch = () => {
    notifyGitChanged();
    onChangeRef.current?.();
    dismiss(true);
  };

  const failMessage = (err: unknown) => dialogErrorWords(err);

  const run = async (pending: PendingSwitch) => {
    if (busy || blocked) return;
    setBusy(true);
    setError(null);
    try {
      await applySwitch(pending);
      finishSwitch();
    } catch (err) {
      // git's own text decides; the person reads it worded (dialogErrorWords).
      if (isCheckoutBlockedByChanges(err instanceof Error ? err.message : String(err))) {
        setOpen(false);
        setQuery("");
        setError(null);
        setBusy(false);
        setBlockedError(null);
        setBlockedBusy(null);
        setBlocked(pending);
        return;
      }
      setError(failMessage(err));
      setBusy(false);
      search.current?.focus();
    }
  };

  /** True once the switch landed; the dialog then plays its exit and runs `finishSwitch`. */
  const resolveBlocked = async (
    kind: "stash" | "commit",
    work: () => Promise<unknown>,
  ): Promise<boolean> => {
    if (!blocked || blockedBusy) return false;
    setBlockedBusy(kind);
    setBlockedError(null);
    try {
      await work();
      await applySwitch(blocked);
      return true;
    } catch (err) {
      setBlockedError(failMessage(err));
      setBlockedBusy(null);
      return false;
    }
  };

  const pick = (row: Row) => {
    if (row.kind === "create") {
      void run({ kind: "create", name: row.name });
      return;
    }
    if (row.branch.current) {
      dismiss(true);
      return;
    }
    void run({
      kind: "checkout",
      name: row.branch.name,
      remote: row.branch.remote,
    });
  };

  // Always keep the control mounted so the composer's toolbar does not resize
  // when a folder isn't a git repo: the loading skeleton, "No repo" and the
  // branch all sit in the same 24px button beside the same icon.
  const awaitingBranch = inProject && !current && !branchesSettled;
  const missingGit = !current && !awaitingBranch;
  const label = current
    ? detached
      ? `detached ${current}`
      : current
    : "No repo";
  const interactive = enabled && !awaitingBranch && !missingGit;
  if (missingGit && !needsRepo) return null;

  const trigger = (
    <Button
      variant="ghost"
      size="xs"
      aria-label={
        awaitingBranch
          ? "Loading branch"
          : missingGit
            ? "No git repository"
            : `Branch ${label}`
      }
      disabled={!interactive || !!blocked}
      className={cn(
        head
          ? "h-7 min-w-0 max-w-full justify-start px-1.5 text-[13px] font-medium text-foreground"
          : cn("min-w-0", ROW_CONTROL),
        missingGit && "disabled:opacity-100",
      )}
    >
      {head ? null : <GitBranch className="size-3.5 shrink-0" />}
      {/* The wait is a load: the name's own bone, drawn from a short branch name in the name's type, so the button
          holds the width a name takes. The button says "Loading branch" itself, so the region says nothing. */}
      <Region
        inline
        loading={awaitingBranch}
        label=""
        className="min-w-0"
        bones={
          <span data-branch-skeleton className={cn("truncate", head ? null : "font-mono text-xs")}>
            main
          </span>
        }
      >
        {head ? (
          <span className="truncate">{label}</span>
        ) : (
          <TruncateTip text={label}>
            {/* Mono only for a real branch name: "No repo" is words. */}
            <span className={cn("truncate text-xs", current && "font-mono")}>{label}</span>
          </TruncateTip>
        )}
      </Region>
      {/* A menu trigger's still chevron, as every picker in the draft row has. */}
      {head || missingGit ? null : <ChevronDown aria-hidden className="size-3 shrink-0" />}
    </Button>
  );

  return (
    <div className={head ? "flex min-w-0 flex-1 items-center" : "flex max-w-[45%] shrink-0 items-center gap-2.5"}>
      <div className="relative min-w-0">
        <LazyPopover
          trigger={trigger}
          tip={tip ? { label: tip } : undefined}
          open={open}
          onOpenChange={(next) => {
            if (next) setOpen(true);
            else dismiss(true);
          }}
          side={head ? "bottom" : "top"}
          align="start"
          label="Branch picker"
          initialFocus={search}
          finalFocus={onClose ? false : undefined}
          className="max-h-70 min-h-45 w-70 gap-0 p-1"
        >
          {/* The popover's children mount only once the menu chunk has landed; the field and the list ride it. */}
          <ListOf
            search={search}
            query={query}
            rows={rows}
            busy={busy}
            emptyLabel={query.trim() ? "No matching branches" : "No branches"}
            onQuery={(next) => {
              setQuery(next);
              setError(null);
            }}
            onPick={pick}
          />
          {error ? (
            <p className="mt-1 max-h-16 shrink-0 overflow-x-hidden overflow-y-auto whitespace-pre-wrap px-2 py-1.5 text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </LazyPopover>
        {blocked ? (
          <SwitchBranchDialog
            cwd={cwd}
            branch={blocked.name}
            creating={blocked.kind === "create"}
            busy={blockedBusy}
            error={blockedError}
            onStash={() =>
              resolveBlocked("stash", () =>
                gitStash(environmentId, cwd, `WIP before switching to ${blocked.name}`),
              )
            }
            onCommit={(message) =>
              resolveBlocked("commit", async () => {
                await gitStageAll(environmentId, cwd);
                await gitCommit(environmentId, cwd, message);
              })
            }
            onSwitched={finishSwitch}
            onCancel={() => {
              if (blockedBusy) return;
              setBlocked(null);
              setBlockedError(null);
              onCloseRef.current?.();
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

/** The list, from the menu chunk the open popover already loaded. */
function ListOf(props: Parameters<typeof BranchRows>[0]) {
  const Body = menuChunk.loaded();
  return Body ? <Body.BranchRows {...props} /> : null;
}
