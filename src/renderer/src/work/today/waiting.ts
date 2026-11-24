import { useMemo } from "react";
import type { SectorKey } from "@shared/work";
import { waitedFor, waitingWho } from "work-kit/mail/lib/waiting";
import { loadToast } from "../../components/ui/toaster";
import { registry } from "../../lib/connection";
import { workOpenPort } from "../../lib/workSwitch";
import { shell } from "../../stores/shell";
import { useLifeosQuery, type LifeosQuery, type LifeosSession } from "../shell/lifeos";
import { act, answerOf, mutate, shown, useLifeosRows, type Lost } from "./lifeos";
import { goTo } from "./open";
import { useStableRows } from "./stable";
import { comeBack, leave } from "./store";
import type { TodayAnswer, TodayEnv, TodayRow, TodaySection, TodaySource, TodayWorkspace } from "./types";

/**
 * Waiting on others: mail he sent that no one answered, as LifeOS keeps it
 * (`mailWaits:list` on the all-sector session, 20 a page, up to five pages
 * while LifeOS says there is more: the first pages may all be waits of
 * sectors with no job), the
 * longest wait first. Nudge starts a thread on the job's host that drafts
 * the follow-up (held, as every draft); Dismiss takes the wait off, with
 * Undo, as Mail's does. Put off stays in Mail.
 */

const SECTION: TodaySection = { id: "waiting", title: "Waiting on others", order: 40, empty: "No one owes you a reply", fold: 5, lifeos: true, bones: "lines" };

export type Wait = {
  _id: string;
  subject: string;
  sector?: SectorKey;
  ownSector?: SectorKey;
  waiting: { since: number; dueAt: number; asked: boolean; to: { name?: string; address: string }[] };
};
type WaitPage = { page: Wait[]; isDone?: boolean; continueCursor?: string };

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
        workspace: { environmentId: workspace.environmentId, workspaceId: workspace.workspaceId },
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
  // Counted as one of the page's own toasts while it is up, through its failure too (lifeos.ts `shown`).
  const up = shown();
  const id = toast.loading("Starting a thread to draft the nudge", up.options);
  try {
    const { sessionId } = await registry.linkOf(workspace.environmentId).request<{ sessionId: string }>("work.mail.nudge", { workspaceId: workspace.workspaceId, threadId });
    toast.dismiss(id);
    up.down();
    shell.closeViews();
    workOpenPort.get()?.(sessionId);
  } catch (error) {
    toast.error("The nudge did not start", { id, description: error instanceof Error ? error.message : undefined, ...up.options });
  }
}

const PAGE = { paginationOpts: { numItems: 20, cursor: null } };
/** A page read with no session: nothing to read, and not on its way. */
const IDLE: LifeosSession = { environmentId: "", sector: null, client: null, state: "off" };
/** The cursor of the page after this one, where LifeOS says there is one. */
const nextOf = (page: LifeosQuery<WaitPage>): string | null => (page.status === "ready" && page.value?.isDone === false && page.value.continueCursor ? page.value.continueCursor : null);
/** One more page of waits, read only once the page before says there is one. */
function useNextPage(session: LifeosSession, after: LifeosQuery<WaitPage> | null): { cursor: string | null; page: LifeosQuery<WaitPage> } {
  const cursor = after ? nextOf(after) : null;
  const page = useLifeosQuery<WaitPage>(cursor ? session : IDLE, "mailWaits:list", { paginationOpts: { numItems: 20, cursor } });
  return { cursor, page };
}
const pick = (value: WaitPage): Wait[] => value.page;
const idOf = (wait: Wait): string => wait._id;
const NONE: readonly TodayRow[] = [];

function useWaiting(env: TodayEnv): TodayAnswer {
  const read = useLifeosRows<WaitPage, Wait>(env, "mailWaits:list", PAGE, pick, idOf);
  const lifeos = env.lifeos;
  // The all-sector read's first page is `read`'s own (the same live query); four more follow its cursor, fixed hooks,
  // each read only once the one before says there is more.
  const head = useLifeosQuery<WaitPage>(lifeos, "mailWaits:list", PAGE);
  const p2 = useNextPage(lifeos, head);
  const p3 = useNextPage(lifeos, p2.cursor ? p2.page : null);
  const p4 = useNextPage(lifeos, p3.cursor ? p3.page : null);
  const p5 = useNextPage(lifeos, p4.cursor ? p4.page : null);
  const more = useMemo(() => {
    const asked = [p2, p3, p4, p5].filter((p) => p.cursor);
    const seen = new Set(read.rows?.map(idOf) ?? []);
    const waits = asked.flatMap((p) => (p.page.status === "ready" ? (p.page.value?.page ?? []) : [])).filter((wait) => !seen.has(wait._id) && !!seen.add(wait._id));
    const lost: Lost[] = asked.flatMap((p) => (p.page.status === "failed" ? [{ environmentId: lifeos.environmentId, sector: null, error: p.page.error }] : []));
    return {
      waits,
      out: asked.some((p) => p.page.status === "loading"),
      lost,
      // The fifth page says there is still more: what is past it is not read, so the section never says no one owes him.
      beyond: !!p5.cursor && nextOf(p5.page) !== null,
    };
    // By their parts: each page's cursor and its query's state, which stay the same objects while nothing moved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [read.rows, p2.cursor, p2.page, p3.cursor, p3.page, p4.cursor, p4.page, p5.cursor, p5.page, lifeos.environmentId]);
  const waits = useMemo(() => (read.rows ? [...read.rows, ...more.waits] : null), [read.rows, more.waits]);
  // A wait is written through the session it was read through: its sector's own, where the first session lacks it.
  const sessionOf = read.sessionOf;
  const today = env.day.from;
  const built = useMemo(() => {
    const via = (wait: Wait) => {
      const sector = sectorOf(wait);
      return sector ? sessionOf(sector) : lifeos;
    };
    return (
      waits &&
      waitingRows(waits, today, {
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
              run: () => mutate(via(wait), "mailWaits:dismiss", fence),
              message: "Dismissed",
              failed: "dismiss it",
              undo: (before) => (before ? mutate(via(wait), "mailWaits:putBack", { ...fence, state: before.state, dueAt: before.dueAt }) : Promise.resolve()).finally(() => comeBack(key)),
            });
          } catch (error) {
            comeBack(key);
            throw error;
          }
        },
      })
    );
  }, [waits, today, env.workspaceOf, sessionOf, lifeos]);
  // What a row's presses close over: the jobs they open in and the sessions they write through.
  const ways = useMemo(() => ({}), [env.workspaceOf, sessionOf]);
  const rows = useStableRows(built ?? NONE, ways);
  const jobName = env.workspaceOf;
  return useMemo<TodayAnswer>(() => {
    // A page still out is a read still out: the section does not say no one owes him a reply while it is.
    const whole = { ...read, pending: read.pending || more.out, lost: more.lost.length ? [...read.lost, ...more.lost] : read.lost };
    const answer = answerOf(whole, built && rows, lifeos, "mail", undefined, (sector) => jobName(sector)?.name);
    return more.beyond && answer.rows ? { ...answer, away: true } : answer;
  }, [read, more, built, rows, lifeos, jobName]);
}

export const source: TodaySource = { id: "waiting", section: SECTION, use: useWaiting };
