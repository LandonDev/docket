import { Bone, Bones } from "../../components/bones";

/**
 * Mail's bones, kept apart from its view so the frame can draw them while the view's chunk is still on its way
 * (work/shell/WorkViewPage.tsx `bones`): the same frame the session's wait draws, so a cold open moves nothing.
 */

/** The list's width: its default, its bounds, and where the app keeps it. */
export const LIST_WIDTH = { base: 296, min: 260, max: 480, key: "tc.mail.listWidth" } as const;

export const clampList = (width: number): number => Math.min(LIST_WIDTH.max, Math.max(LIST_WIDTH.min, Math.round(width)));

export function readListWidth(): number {
  try {
    const kept = Number(localStorage.getItem(LIST_WIDTH.key));
    return kept ? clampList(kept) : LIST_WIDTH.base;
  } catch {
    return LIST_WIDTH.base;
  }
}

/*
 * The sample a cold open is drawn from. Nobody reads it: its lengths give the rows the shape of a real inbox.
 * Fixed literals, a row's sender, its time, its subject and the first words of its last message.
 */
const SAMPLE_THREADS = [
  { from: "Jordan Ellis", at: "9:42 AM", subject: "The venue for Saturday", lead: "Doors open at six, so we should be there by five." },
  { from: "Priya Natarajan", at: "9:10 AM", subject: "Budget for the spring term", lead: "Here is the sheet with the three options we talked about." },
  { from: "Sam Ortiz", at: "8:31 AM", subject: "Re: Streams this week", lead: "Thursday works for me, Friday is tight." },
  { from: "Morgan Lee", at: "Yesterday", subject: "Contract, second draft", lead: "I marked the two clauses that changed since last time." },
  { from: "Alex Chen", at: "Yesterday", subject: "Photos from the finals", lead: "The folder is shared with you now." },
  { from: "Riley Brooks", at: "Mon", subject: "Re: Room booking", lead: "The east room is free from two until four." },
  { from: "Casey Hart", at: "Mon", subject: "Minutes from Monday", lead: "Short ones this time, three things to follow up." },
  { from: "Taylor Quinn", at: "Sun", subject: "Travel for the regional", lead: "Flights are held until Wednesday at noon." },
] as const;

const SAMPLE_MESSAGE = {
  subject: "The venue for Saturday",
  from: "Jordan Ellis",
  address: "jordan@example.com",
  at: "9:42 AM",
  lines: ["Doors open at six, so we should be there by five to set up the stage and the casters' desk.", "The loading door is round the back, by the car park.", "I will send the floor plan once they confirm it."],
} as const;

/**
 * While the session opens: the mailbox's list beside its reading pane, the frame Mail lands in, drawn in work-kit's
 * own row grid (thread-list.tsx's 20px gutter, 32px face cell, 68px rows 1px apart) and in its type, so a cold open
 * moves nothing when the mailbox comes in. work-kit's list and pane draw their own waits after that.
 */
export function MailBones() {
  return (
    <Bones label="Loading Mail" className="h-full min-h-0 select-none">
      <div className="@container/mail flex min-h-0 flex-1">
        <div style={{ width: readListWidth() }} className="flex shrink-0 flex-col overflow-hidden border-r border-border @max-[40rem]/mail:w-full! @max-[40rem]/mail:border-r-0">
          <div className="flex h-11 shrink-0 items-center gap-1.5 px-4 text-[13px]">
            <span className="font-semibold">Inbox</span>
            <span className="tabular-nums">12</span>
          </div>
          <div className="shrink-0 px-3 pb-2">
            <Bone className="h-7 w-full rounded-md" />
          </div>
          <div className="min-h-0 flex-1 overflow-hidden px-1.5">
            {SAMPLE_THREADS.map((thread) => (
              <div key={thread.subject} style={{ height: 68, marginBottom: 1 }} className="grid grid-cols-[20px_32px_minmax(0,1fr)] content-start py-1.5 ps-1 pe-2.5">
                <span skullet-own="" className="row-span-3" />
                <span className="row-span-3 flex h-8 items-end self-start">
                  <Bone className="size-6 rounded-full" />
                </span>
                <span className="flex h-5 min-w-0 items-center justify-between gap-6 text-sm">
                  <span className="truncate font-medium">{thread.from}</span>
                  <span className="shrink-0 text-xs tabular-nums">{thread.at}</span>
                </span>
                <span className="h-5 truncate text-sm leading-5">{thread.subject}</span>
                <span className="h-4 truncate text-xs leading-4">{thread.lead}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="min-w-0 flex-1 px-6 pt-5 @max-[40rem]/mail:hidden">
          <div className="mx-auto flex max-w-[680px] flex-col">
            <p className="h-6 truncate text-lg font-semibold leading-6">{SAMPLE_MESSAGE.subject}</p>
            <div className="mt-4 border-t border-border pt-3">
              <div className="grid grid-cols-[1.75rem_minmax(0,1fr)_auto] items-center gap-x-2.5">
                <Bone className="size-7 rounded-full" />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-sm font-medium leading-5">{SAMPLE_MESSAGE.from}</span>
                  <span className="truncate text-xs leading-4">{SAMPLE_MESSAGE.address}</span>
                </span>
                <span className="text-xs tabular-nums">{SAMPLE_MESSAGE.at}</span>
              </div>
              <div className="mt-4 flex flex-col gap-2 text-sm leading-5">
                {SAMPLE_MESSAGE.lines.map((line) => (
                  <p key={line}>{line}</p>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </Bones>
  );
}
