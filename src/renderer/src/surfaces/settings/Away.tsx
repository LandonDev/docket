import { useEffect, useState } from "react";
import { anyAway, decidedTotal, type AwayDecided } from "@server/shared/away";
import { useStore } from "zustand";
import { AwayReviewDialog } from "../../chrome/AwayReviewDialog";
import { decidedThreadsOf, decisionsLabel } from "../../chrome/awayReturnModel";
import { PageSection } from "../../components/page";
import { SettingSwitch } from "../../components/setting-switch";
import { registry } from "../../lib/connection";
import { awayKinds, awayStore, setAway, startAway, useAway, type HostAway } from "../../lib/away";
import { clockTime, dayTime } from "../../lib/duration";
import { useWorkOn } from "../../lib/workSwitch";
import { SettingRow } from "./parts/SettingRow";
import { useSaved, type Saved } from "./parts/useSaved";

/**
 * Settings → Away (docs/agents/away-from-computer.md): the rail's switch as a page, a switch per kind of thread, and
 * the last stretch away with what was decided in it. One store (lib/away.ts: `away.get`, `away.set`), so the page and
 * the rail never disagree; a flip shows at once with its row's Saved, and a refusal puts it back with the store's own
 * toast. Work's switch is here only while some computer has Work on.
 */
export function AwayPage({ onOpenSession }: { onOpenSession?: (sessionId: string) => void }) {
  const { code, work, at } = useAway();
  const workOn = useWorkOn();
  useEffect(() => startAway(), []);
  const saved = { code: useSaved(), work: useSaved() };
  const since = at > 0 ? `On since ${clockTime(at)}` : undefined;
  const flip = (kind: "code" | "work") => (on: boolean) =>
    saved[kind].run(async () => {
      await setAway({ [kind]: on });
      // The store says a refusal in its own toast and puts the switch back: the row shows no second line.
      return awayKinds()[kind] === on;
    });
  // The refusal is the store's toast; the row keeps its mark alone.
  const quiet = (s: Saved): Saved => ({ ...s, error: null });
  return (
    <>
      <PageSection>
        <SettingRow id="away.code" description={code ? since : undefined} saved={quiet(saved.code)}>
          <SettingSwitch label="Code threads" on={code} onChange={flip("code")} />
        </SettingRow>
        {workOn ? (
          <SettingRow id="away.work" description={work ? since : undefined} saved={quiet(saved.work)}>
            <SettingSwitch label="Work threads" on={work} onChange={flip("work")} />
          </SettingRow>
        ) : null}
      </PageSection>
      <LastTimeAway onOpenSession={onOpenSession} />
    </>
  );
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
