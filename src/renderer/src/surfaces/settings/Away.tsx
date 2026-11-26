import { useEffect, useState } from "react";
import { anyAway, awayKindsOf, awayStateOf, decidedTotal, type AwayDecided, type AwayKinds, type AwayState } from "@server/shared/away";
import { useStore } from "zustand";
import { AwayReviewDialog } from "../../chrome/AwayReviewDialog";
import { decidedThreadsOf, decisionsLabel } from "../../chrome/awayReturnModel";
import { PageRowsSkeleton, PageSection } from "../../components/page";
import { SettingSwitch } from "../../components/setting-switch";
import { registry, useEnvironments } from "../../lib/connection";
import { useHostRead } from "../../lib/connection/hostRead";
import { useLinkMay } from "../../lib/linkMay";
import { computerInLine, useComputerName, useComputerNames } from "../../lib/settings/computerName";
import { andList } from "@shared/addons";
import type { AwaySnapshot } from "@shared/contract-away";
import { ManagedLine } from "./parts/ManagedLine";
import { hostRequest } from "./parts/hostRpc";
import { thisDesktopInLine, thisDesktopName } from "../../lib/native";
import { dialogErrorWords } from "../../lib/dialogErrorWords";
import { isWebMode } from "../../lib/nativeWeb";
import { ReadFailure } from "./parts/ReadFailure";
import { awayKinds, awayStore, startAway, useAway, type HostAway } from "../../lib/away";
import { clockTime, dayTime } from "../../lib/duration";
import { useWorkOn } from "../../lib/workSwitch";
import { SettingRow } from "./parts/SettingRow";
import { useSaved } from "./parts/useSaved";

/**
 * Settings → Away (docs/agents/away-from-computer.md): the rail's switch as a page, a switch per kind of thread, and
 * the last stretch away with what was decided in it. One store (lib/away.ts: `away.get`, `away.set`), so the page and
 * the rail never disagree; a flip shows at once with its row's Saved, and a refusal puts it back with its reason on the
 * row (`flipAway`). Work's switch is here only while some computer has Work on. The page never reads Off before this window's
 * computer has said: it asks `away.get` itself, shows the rows' bones until an answer, and on a failure the one line
 * with Retry. A key that may not approve sees the state as words.
 */
export function AwayPage({ onOpenSession }: { onOpenSession?: (sessionId: string) => void }) {
  const environmentId = registry.primaryEnvironmentId;
  const link = registry.linkOf(environmentId);
  const workOn = useWorkOn();
  const environments = useEnvironments();
  useEffect(() => startAway(), []);
  // The store says nothing of a read it could not make: the page's own read knows waiting from failed.
  const read = useHostRead<AwaySnapshot>(link, () => link.request<AwaySnapshot>("away.get", {}));
  const heard = useStore(awayStore, (s) => s["hosts"][environmentId] !== undefined);
  const stored = useAway();
  const answered = heard ? stored : read.value ? { ...awayKindsOf(read.value.state), at: read.value.state.at } : null;
  const may = useLinkMay(environmentId, "away.set", { code: true });
  const computer = useComputerName(environmentId);
  const saved = { code: useSaved(), work: useSaved() };
  if (!answered) {
    return read.error ? (
      <ReadFailure computer={environmentId} error={read.error} retry={read.retry} />
    ) : (
      <PageSection>
        <PageRowsSkeleton rows={workOn ? 2 : 1} control="switch" />
      </PageSection>
    );
  }
  const { code, work, at } = answered;
  const since = at > 0 ? `On since ${clockTime(at)}` : undefined;
  // The page sends the flip itself, so a refusal's reason is the row's red line (the rail keeps the store's toast).
  const flip = (kind: "code" | "work") => (on: boolean) => saved[kind].run(() => flipAway(environmentId, { [kind]: on }, computer.own ? thisDesktopName() : computer.name));
  const control = (kind: "code" | "work", on: boolean, label: string) =>
    may ? <SettingSwitch label={label} on={on} onChange={flip(kind)} /> : <span className="text-xs text-muted-foreground">{on ? "On" : "Off"}</span>;
  return (
    <>
      <PageSection description={environments.length > 1 ? <AwayScope /> : undefined}>
        <SettingRow id="away.code" description={code ? since : undefined} saved={may ? saved.code : undefined}>
          {control("code", code, "Code threads")}
        </SettingRow>
        {workOn ? (
          <SettingRow id="away.work" description={work ? since : undefined} saved={may ? saved.work : undefined}>
            {control("work", work, "Work threads")}
          </SettingRow>
        ) : null}
        {may ? null : <ManagedLine computer={computer.name} />}
      </PageSection>
      <LastTimeAway onOpenSession={onOpenSession} />
    </>
  );
}

/**
 * One flip of Away, as the rail's `setAway` (lib/away.ts) makes it: the same method and params, shown at once through
 * the store's `pending`, the host's stamped state taken into the store from the answer. Unlike `setAway` it rejects on
 * a refusal, with the host's reason, and leaves no toast: the row says it.
 */
export async function flipAway(environmentId: string, change: Partial<AwayKinds>, computer = "This Mac"): Promise<void> {
  const kinds = { ...awayKinds(), ...change };
  const flip = awayStateOf(kinds, Date.now(), "");
  awayStore.setState({ pending: flip });
  try {
    const { state } = await hostRequest<{ state: AwayState }>(environmentId, "away.set", { enabled: kinds.code && kinds.work, ...change });
    const now = awayStore.getState();
    if (now.pending !== flip) return;
    const heard = now.hosts[environmentId];
    // The answer is the host's word; a push as new or newer has already said it.
    if (heard && heard.state.at >= state.at) awayStore.setState({ pending: null });
    else awayStore.setState({ pending: null, hosts: { ...now.hosts, [environmentId]: { decided: heard?.decided ?? { since: 0, threads: [] }, state } } });
  } catch (err) {
    if (awayStore.getState().pending === flip) awayStore.setState({ pending: null });
    // The host's refusal in a person's words ("This computer's key may not do that on the box."), never its raw text.
    throw new Error(dialogErrorWords(err, computer) || "This did not save.");
  }
}

/** Which computers Away holds for, by their names: every linked computer keeps the same switches, and one out of
 *  reach takes a change when it is back. */
function AwayScope() {
  const environments = useEnvironments();
  const names = useComputerNames();
  const ids = [registry.primaryEnvironmentId, ...environments.map((environment) => environment.id).filter((id) => id !== registry.primaryEnvironmentId && id !== "local")];
  // This window's own computer is "this Mac" in a desktop window, by its name at /ui.
  const said = [...new Set(ids.map((id) => (id === registry.primaryEnvironmentId && !isWebMode() ? thisDesktopInLine() : computerInLine(names(id)))))];
  // With one computer there is nothing to name: the page is about it alone.
  if (said.length < 2) return null;
  return <>{`The same on ${andList(said)}. One out of reach takes a change when it is back.`}</>;
}

/** The last stretch away, once it has ended: every computer's tally of it, as the return toast reads them. */
export function useLastTimeAway(): { endedAt: number; tallies: ReadonlyMap<string, AwayDecided> } | null {
  const computers: Readonly<Record<string, HostAway>> = useStore(awayStore, (s) => s["hosts"]);
  const own = computers[registry.primaryEnvironmentId];
  const ended = (computer: HostAway | undefined): computer is HostAway => !!computer && !anyAway(computer.state) && computer.decided.since > 0;
  if (!ended(own)) return null;
  const tallies = new Map(Object.entries(computers).flatMap(([id, computer]) => (ended(computer) ? [[id, computer.decided] as const] : [])));
  return { endedAt: own.state.at, tallies };
}

/** "Last time away": when it ended and how many decisions threads made for him, opening Back from Away's list. */
function LastTimeAway({ onOpenSession }: { onOpenSession?: (sessionId: string) => void }) {
  const last = useLastTimeAway();
  const [open, setOpen] = useState(false);
  if (!last) return null;
  const threads = decidedThreadsOf(last.tallies);
  const decisions = [...last.tallies.values()].reduce((sum, decided) => sum + decidedTotal(decided), 0);
  const line = `Ended ${dayTime(last.endedAt)}, ${decisions ? `${decisionsLabel(decisions)} made for you` : "no decisions made for you"}`;
  return (
    <PageSection>
      {threads.length ? (
        <SettingRow id="away.last" description={line} onOpen={() => setOpen(true)} openLabel="Last time away" />
      ) : (
        <SettingRow id="away.last" description={line} />
      )}
      {open ? (
        <AwayReviewDialog
          threads={threads}
          onOpen={(sessionId) => onOpenSession?.(sessionId)}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </PageSection>
  );
}
