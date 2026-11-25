// A preview page for `bun run ui:preview src/renderer/src/work/guests/Share.preview.tsx#SharePreview --props '{"state":"open"}'`:
// Share on a document, over a host that answers from made-up guest links. States: `open` (the Share sheet with the
// item's links), `none` (the sheet with no link yet), `purdue` (a Purdue workspace's sheet, its line beside Create
// link), `why` (a Word file's sheet: the line that says how to share it instead), `made` (Settings' dialog with a new
// link's address), `section` (Settings → Work's Guest links with live, ended and revoked links) and `held` (an
// agent's held link request for a file, as the Outbox shows it). Rendered by nothing in the app.
import type { CanvasSource, HeldItem } from "@shared/work";
import { Page } from "../../components/page";
import { answerAs, OverFrame, usePressNamed, Unsettled } from "../kit.preview";
import type { GuestLinkRow, GuestSource } from "./api";
import { GuestLinksSection } from "./GuestLinksSection";
import { MadeLinkDialog, ShareButton } from "./Share";
import { View as HeldLink } from "./ShareActView";

type State = "open" | "none" | "purdue" | "why" | "made" | "section" | "held";

const NOW = Date.now();
const DAY = 86_400_000;
const SOURCE = { at: "lifeos", table: "docs", id: "d1" } as const satisfies GuestSource & CanvasSource;
const link = (id: string, name: string, role: GuestLinkRow["role"], over: Partial<GuestLinkRow> = {}): GuestLinkRow => ({ id, name, source: SOURCE, title: "Spring LAN run of show", role, createdAt: NOW - 2 * DAY, expiresAt: NOW + 12 * DAY, revokedAt: null, by: "owner", lastOpenedAt: null, open: 0, ...over });
const LINKS: GuestLinkRow[] = [
  link("g1", "Maya Chen", "comment", { lastOpenedAt: NOW - 3 * 3_600_000, open: 2 }),
  link("g2", "Memorial Union events office", "view"),
  link("g3", "Sam Ortiz", "edit", { expiresAt: NOW - DAY, title: "Seat plan", source: { at: "lifeos", table: "sheets", id: "s1" } }),
  link("g4", "Priya Raman", "view", { revokedAt: NOW - 4 * DAY, title: "Budget request" }),
];

const WORD = { at: "file", host: "local", path: "/home/work/Spring LAN run of show.docx" } as const satisfies CanvasSource;

let ready = false;

export function SharePreview({ state = "open" }: { state?: State }) {
  if (!ready) {
    ready = true;
    answerAs((method) => {
      if (method === "work.guests.forItem") return state === "none" ? [] : LINKS.slice(0, 2);
      if (method === "work.guests.list") return LINKS;
      throw new Error(`no ${method}`);
    });
  }
  // Share is the bar's own press.
  usePressNamed(state === "open" || state === "none" || state === "purdue" || state === "why" ? "Share" : null, 60);
  if (state === "held") {
    const item = { kind: "share.guestLink", payload: { source: { at: "file", host: "local", path: "/home/work/Purdue/Trips/Field trip plan.tcdoc" }, title: "Field trip plan", name: "Dana Lee", role: "comment", expiresAt: NOW + 14 * DAY } } as unknown as HeldItem;
    return (
      <div className="w-full p-4" style={{ maxWidth: 480 }}>
        <HeldLink item={item} env="local" />
      </div>
    );
  }
  if (state === "section")
    return (
      <div className="w-full" style={{ maxWidth: 720 }}>
        <Page title="Work">
          <GuestLinksSection hosts={["local"]} />
        </Page>
        <Unsettled />
      </div>
    );
  return (
    <OverFrame maxWidth={720} height={state === "open" ? 520 : 400} place={{ top: 44, right: 8 }}>
      <div className="flex h-10 items-center gap-2 border-b border-border px-3 text-sm font-medium">
        Spring LAN run of show
        <ShareButton env="local" source={state === "why" ? WORD : SOURCE} kind="document" title="Spring LAN run of show" purdue={state === "purdue"} />
      </div>
      {state === "made" ? <MadeLinkDialog url="https://tempcode.example.com/g/AbCdEfGhIjKl" link={{ name: "Maya Chen", role: "comment", expiresAt: NOW + 14 * DAY }} title="Spring LAN run of show" onClose={() => undefined} /> : null}
      <Unsettled />
    </OverFrame>
  );
}
