import { useMemo } from "react";
import type { SectorKey } from "@shared/work";
import { waitedFor, waitingWho } from "work-kit/mail/lib/waiting";
import { loadToast } from "../../components/ui/toaster";
import { registry } from "../../lib/connection";
import { workOpenPort } from "../../lib/workSwitch";
import { shell } from "../../stores/shell";
import { act, mutate, sessionDown, useLifeosRows } from "./lifeos";
import { goTo } from "./open";
import { useStableRows } from "./stable";
import { comeBack, leave } from "./store";
import type { TodayAnswer, TodayEnv, TodayRow, TodaySection, TodaySource, TodayWorkspace } from "./types";

/**
 * Waiting on others: mail he sent that no one answered, as LifeOS keeps it
 * (`mailWaits:list`, the first page of 20, on the all-sector session), the
 * longest wait first. Nudge starts a thread on the job's host that drafts
 * the follow-up (held, as every draft); Dismiss takes the wait off, with
 * Undo, as Mail's does. Put off stays in Mail.
 */

const SECTION: TodaySection = { id: "waiting", title: "Waiting on others", order: 40, empty: "No one owes you a reply", fold: 5, lifeos: true };

export type Wait = {
  _id: string;
  subject: string;
  sector?: SectorKey;
  ownSector?: SectorKey;
  waiting: { since: number; dueAt: number; asked: boolean; to: { name?: string; address: string }[] };
};
type WaitPage = { page: Wait[] };

export const mailKey = (id: string): string => `mail:${id}`;
const sectorOf = (wait: Wait): SectorKey | null => wait.sector ?? wait.ownSector ?? null;

type Ways = {
  workspaceOf(sector: SectorKey): TodayWorkspace | null;
  open(workspace: TodayWorkspace, wait: Wait): void;
  nudge(workspace: TodayWorkspace, wait: Wait): Promise<void>;
  dismiss(wait: Wait): Promise<void>;
};

/** The waits as rows: whom he wrote to, the subject, how long he has waited. A sector with no job is left out. */
export function waitingRows(waits: readonly Wait[], today: number, ways: Ways): TodayRow[] {
  return waits.flatMap((wait): TodayRow[] => {
    const sector = sectorOf(wait);
    const workspace = sector ? ways.workspaceOf(sector) : null;
    if (!sector || !workspace) return [];
    return [
      {
        key: mailKey(wait._id),
        section: SECTION.id,
        sector,
        title: waitingWho(wait.waiting.to),
        ...(wait.subject ? { detail: wait.subject } : {}),
        at: wait.waiting.since,
        when: waitedFor(wait.waiting.since, today),
        open: () => ways.open(workspace, wait),
        acts: [
          { label: "Nudge", run: () => ways.nudge(workspace, wait) },
          { label: "Dismiss", run: () => ways.dismiss(wait) },
        ],
      },
    ];
  });
}

/** The host starts a Work thread that drafts the follow-up, and the thread opens; a refusal says why. */
export async function startNudge(workspace: TodayWorkspace, threadId: string): Promise<void> {
  const toast = await loadToast();
  const id = toast.loading("Starting a thread to draft the nudge");
  try {
    const { sessionId } = await registry.linkOf(workspace.environmentId).request<{ sessionId: string }>("work.mail.nudge", { workspaceId: workspace.workspaceId, threadId });
    toast.dismiss(id);
    shell.closeViews();
    workOpenPort.get()?.(sessionId);
  } catch (error) {
    toast.error("The nudge did not start", { id, description: error instanceof Error ? error.message : undefined });
  }
}

const PAGE = { paginationOpts: { numItems: 20, cursor: null } };
const pick = (value: WaitPage): Wait[] => value.page;
const idOf = (wait: Wait): string => wait._id;
const NONE: readonly TodayRow[] = [];

function useWaiting(env: TodayEnv): TodayAnswer {
  const read = useLifeosRows<WaitPage, Wait>(env, "mailWaits:list", PAGE, pick, idOf);
  const lifeos = env.lifeos;
  const today = env.day.from;
  const built = useMemo(
    () =>
      read.rows &&
      waitingRows(read.rows, today, {
        workspaceOf: env.workspaceOf,
        open: (workspace, wait) => goTo(workspace, { view: "mail", mail: wait._id }),
        nudge: (workspace, wait) => startNudge(workspace, wait._id),
        dismiss: async (wait) => {
          const key = mailKey(wait._id);
          // `since` fences a row that moved on: he wrote again, and the wait he sees is not the one LifeOS holds.
          const fence = { threadId: wait._id, since: wait.waiting.since };
          leave(key);
          try {
            await act<{ state: string; dueAt: number } | null>({
              run: () => mutate(lifeos, "mailWaits:dismiss", fence),
              message: "Dismissed",
              failed: "dismiss it",
              undo: (before) => (before ? mutate(lifeos, "mailWaits:putBack", { ...fence, state: before.state, dueAt: before.dueAt }) : Promise.resolve()).finally(() => comeBack(key)),
            });
          } catch (error) {
            comeBack(key);
            throw error;
          }
        },
      }),
    [read.rows, today, env.workspaceOf, lifeos],
  );
  const rows = useStableRows(built ?? NONE);
  const down = sessionDown(lifeos);
  const host = lifeos.environmentId;
  return useMemo<TodayAnswer>(() => {
    if (read.error && !down) return { rows: [], failed: [{ environmentId: host, error: read.error }] };
    if (!built) return { loading: true };
    return { rows };
  }, [built, rows, read.error, down, host]);
}

export const source: TodaySource = { id: "waiting", section: SECTION, use: useWaiting };
