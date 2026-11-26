// A preview frame for `bun run ui:preview src/hosted/guest/GuestApp.preview.tsx#GuestPagePreview --width 864`:
// the guest's page (docs/DESIGN.md "The guest's page") over a stand-in host that answers the link's reads: a project's
// link with its line and screens, a project's document that did not open, and an Edit link's document and sheet as far
// as they draw with no live socket (the editor and the grid wait for theirs).
import type { GuestProjection } from "@shared/work/guestProjection";
import { GuestApp } from "./GuestApp";

export type GuestMoment = "project" | "child-failed" | "doc" | "sheet";

const UNTIL = Date.UTC(2026, 11, 18);
const projection: GuestProjection = {
  project: { id: "kproj1", name: "Spring LAN", status: "active", description: "Two days of matches in the ballroom, with a stream on the second.", docId: null },
  counts: { todo: 2, doing: 1, waiting: 0, done: 1 },
  tasks: [
    { id: "kt1", key: "PUR-1", parentId: null, rank: "a", title: "Book the ballroom", status: "done", priority: null, dueAt: null, notes: "" },
    { id: "kt2", key: "PUR-2", parentId: null, rank: "b", title: "Order the team badges", status: "doing", priority: "high", dueAt: UNTIL - 9 * 86_400_000, notes: "" },
    { id: "kt3", key: "PUR-3", parentId: null, rank: "c", title: "Confirm the stream desk", status: "todo", priority: null, dueAt: null, notes: "" },
    { id: "kt4", key: "PUR-4", parentId: null, rank: "d", title: "Print the brackets", status: "todo", priority: null, dueAt: null, notes: "" },
  ],
  truncated: false,
  docs: [{ id: "kdocrun", title: "Run of show" }],
  sheets: [{ id: "kbudget", title: "Budget" }],
} as GuestProjection;

const answer = (status: number, json: unknown) => ({ ok: status < 400, status, json: async () => json }) as Response;
const LINK = { role: "edit", name: "Dana Lee", owner: "Landon Hale", expiresAt: UNTIL, token: "preview", tokenExp: Date.now() + 3_600_000, me: "guest:L1" };

/** The host as the page asks it: each read answered at once, a project's document refused where the moment says. */
function standIn(moment: GuestMoment): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const path = new URL(url, "http://localhost").pathname;
    const body = JSON.parse(String(init?.body ?? "{}")) as { table?: string };
    if (path.endsWith("/open")) {
      if (moment === "doc") return answer(200, { ...LINK, kind: "doc", title: "Run of show", doc: "kdocrun" });
      if (moment === "sheet") return answer(200, { ...LINK, kind: "sheet", title: "Budget", sheet: "kbudget" });
      return answer(200, { ...LINK, kind: "project", role: "view", title: "Spring LAN", projection });
    }
    if (path.endsWith("/item")) return moment === "child-failed" && body.table === "docs" ? answer(500, { error: "down" }) : answer(200, { ...LINK, kind: "doc", role: "view", title: "Run of show", markdown: "Doors open at 9:00 AM." });
    if (path.endsWith("/threads")) return answer(200, { rows: [], names: {} });
    return answer(404, {});
  }) as typeof fetch;
}

export function GuestPagePreview({ moment = "project" }: { moment?: GuestMoment }) {
  // The link's address and its host, as the page reads them when it starts.
  window.history.replaceState(null, "", `/g/L1#k=${"k".repeat(43)}`);
  globalThis.fetch = standIn(moment);
  return (
    <div data-guest-preview className="h-[560px] w-full overflow-hidden rounded-xl border border-border [&>div]:h-full">
      <GuestApp />
    </div>
  );
}
