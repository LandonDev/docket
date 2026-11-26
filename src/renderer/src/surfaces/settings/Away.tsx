import { useEffect, useState } from "react";
import { anyAway, awayKindsOf, decidedTotal, type AwayDecided } from "@server/shared/away";
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
import { thisDesktopInLine } from "../../lib/native";
import { isWebMode } from "../../lib/nativeWeb";
import { ReadFailure } from "./parts/ReadFailure";
import { awayKinds, awayStore, setAway, startAway, useAway, type HostAway } from "../../lib/away";
import { clockTime, dayTime } from "../../lib/duration";
import { useWorkOn } from "../../lib/workSwitch";
import { SettingRow } from "./parts/SettingRow";
import { useSaved, type Saved } from "./parts/useSaved";

/**
 * Settings → Away (docs/agents/away-from-computer.md): the rail's switch as a page, a switch per kind of thread, and
 * the last stretch away with what was decided in it. One store (lib/away.ts: `away.get`, `away.set`), so the page and
 * the rail never disagree; a flip shows at once with its row's Saved, and a refusal puts it back with the store's own
 * toast. Work's switch is here only while some computer has Work on. The page never reads Off before this window's
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
  const flip = (kind: "code" | "work") => (on: boolean) =>
    saved[kind].run(async () => {
      await setAway({ [kind]: on });
      // The store says a refusal in its own toast and puts the switch back: the row shows no second line.
      return awayKinds()[kind] === on;
    });
  // The refusal is the store's toast; the row keeps its mark alone.
  const quiet = (s: Saved): Saved => ({ ...s, error: null });
  const control = (kind: "code" | "work", on: boolean, label: string) =>
    may ? <SettingSwitch label={label} on={on} onChange={flip(kind)} /> : <span className="text-xs text-muted-foreground">{on ? "On" : "Off"}</span>;
  return (
    <>
      <PageSection description={environments.length > 1 ? <AwayScope /> : undefined}>
        <SettingRow id="away.code" description={code ? since : undefined} saved={may ? quiet(saved.code) : undefined}>
          {control("code", code, "Code threads")}
        </SettingRow>
        {workOn ? (
          <SettingRow id="away.work" description={work ? since : undefined} saved={may ? quiet(saved.work) : undefined}>
            {control("work", work, "Work threads")}
          </SettingRow>
        ) : null}
        {may ? null : <ManagedLine computer={computer.name} />}
      </PageSection>
      <LastTimeAway onOpenSession={onOpenSession} />
    </>
  );
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
