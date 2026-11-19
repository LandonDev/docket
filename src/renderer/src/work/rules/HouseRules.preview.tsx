import type { DraftEdit, HouseRule, RuleProposal } from "@shared/contract-work-rules";
import { Page } from "../../components/page";
import { registry, type Link } from "../../lib/connection";
import { workspaceStore } from "../../lib/tcserver/workspaces";
import { Evidence } from "./Evidence";
import { HouseRules } from "./HouseRules";
import { RuleLine } from "./RuleLine";

/**
 * House rules over one fixed host, for `bun run ui:preview
 * src/renderer/src/work/rules/HouseRules.preview.tsx#HouseRulesPreview --props '{"state":"page"}'`:
 * the workspace's rules page (`page`, `empty`, `many`) and the line under a
 * sent mail (`line`, with its edits open, and `added`). Rendered by nothing
 * in the app.
 */

const WS = { id: "ws", name: "Purdue Esports", path: "/home/work/Purdue Esports", kind: "work", sector: "purdue", createdAt: 1 };
const rule = (i: number, text: string, on = true): HouseRule => ({ id: `r${i}`, workspaceId: "ws", text, on, proposalId: null, createdAt: i, updatedAt: i });
const RULES = [
  "Sign Purdue mail as Landon Hale, Assistant Director, Esports, Purdue RecWell, West Lafayette",
  "Write to Sam in two lines or fewer",
  "Never promise a vendor a date before the PO is approved",
  "Send Purdue mail as plain text",
  "Copy Sam Ortiz on anything about scrims",
  "Call it the Spring LAN, never the spring tournament",
];
const MORE = ["Put money in whole dollars, with no cents", "Ask Dana Lee before moving money between budget lines", "Book rooms through events booking, never by phone", "Write dates as weekday, month and day: Sat, Apr 10", "Never share a player's grades or student ID", "Name the team Purdue Esports, not Boilermaker Esports", "Answer parents within one working day", "Say players, not gamers"];

const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).getTime();
const ed = (draftId: string, to: string, subject: string, sentAt: number, ops: DraftEdit["ops"]): DraftEdit => ({ draftId, to, subject, sentAt, ops });
const GREET: RuleProposal = {
  id: "greet",
  workspaceId: "ws",
  text: "Keep the greeting to one line",
  line: "You cut the greeting to one line again.",
  state: "open",
  ruleId: null,
  updatedAt: 3,
  edits: [
    ed("d3", "Events booking", "Re: Ballroom for April 10", at(19, 14, 4), [
      { op: "=", text: "Hi Karen, " },
      { op: "-", text: "thank you so much for getting back to me so quickly, it is much appreciated!" },
      { op: "+", text: "Thank you." },
      { op: "=", text: " Our headcount is 120." },
    ]),
    ed("d2", "Dana Lee", "Nationals budget: need it by Friday", at(18, 9, 40), [
      { op: "=", text: "Hi Dana, " },
      { op: "-", text: "Thank you so much for your patience while I pulled all of this together. " },
      { op: "=", text: "The draft budget is attached, $16,294 with contingency." },
    ]),
    ed("d1", "Sam Ortiz", "Re: Scrim schedule v2", at(17, 14, 14), [
      { op: "=", text: "Hi Sam, " },
      { op: "-", text: "I hope your week is off to a great start! Thanks so much for sending this over. " },
      { op: "=", text: "Thursday at 7 works for varsity." },
    ]),
  ],
};
const HOURS: RuleProposal = {
  id: "hours",
  workspaceId: "ws",
  text: "Write “3 PM”, not “3:00 PM”",
  line: "You changed “3:00 PM” to “3 PM” again.",
  state: "later",
  ruleId: null,
  updatedAt: 2,
  edits: [
    ed("d5", "Big Ten Esports", "Re: League call moved to Thursday", at(12, 10), [
      { op: "=", text: "Thursday at " },
      { op: "-", text: "3:00 PM" },
      { op: "+", text: "3 PM" },
      { op: "=", text: " works for us." },
    ]),
    ed("d4", "Sam Ortiz", "Scrim vs. Illinois", at(13, 16), [
      { op: "=", text: "Doors open at " },
      { op: "-", text: "4:00 PM" },
      { op: "+", text: "4 PM" },
      { op: "=", text: " in the arena." },
    ]),
  ],
};

type State = "page" | "empty" | "many" | "line" | "added";
let state: State = "page";

const answers = (): Record<string, unknown> => ({
  "workspace.list": [WS],
  "project.list": [],
  "work.rules.list": {
    rules: state === "empty" ? [] : (state === "many" ? [...RULES, ...MORE] : RULES).map((t, i) => rule(i, t, i !== 4)),
    proposals: state === "empty" ? [] : [GREET, HOURS],
  },
  "work.rules.forDraft": { workspaceId: "ws", proposals: [state === "added" ? { ...GREET, state: "added", ruleId: "r9" } : GREET] },
  "work.rules.voice": state === "empty" ? { on: false, count: 31, since: at(19 - 30, 9), from: ["landon.refs@gmail.com"] } : { on: true, count: 48, since: new Date(2026, 9, 19).getTime(), from: ["landon@purdue.edu"] },
});

const link = {
  environmentId: "local",
  profile: "local",
  connected: true,
  onOpen: () => () => {},
  onClose: () => () => {},
  onPush: () => () => {},
  request<T>(method: string): Promise<T> {
    const all = answers();
    return method in all ? Promise.resolve(all[method] as T) : Promise.reject(new Error(`no ${method}`));
  },
} as unknown as Link;
Object.assign(registry, { primary: () => link, linkOf: () => link, link: () => link });
workspaceStore.reset();
workspaceStore.attach(link);

export function HouseRulesPreview({ state: s = "page" }: { state?: State }) {
  state = s;
  const workspace = { ...WS, environmentId: "local" } as never;
  if (s === "line" || s === "added")
    return (
      <div className="mx-auto w-full max-w-[768px] p-6">
        <div className="rounded-lg bg-muted px-3 py-2 text-sm">Answer Karen: headcount 120, insurance comes Thursday.</div>
        <p className="mt-3 text-sm leading-[22px]">The reply to Karen is drafted: headcount 120, and the certificate of insurance follows from RecWell on Thursday.</p>
        <RuleLine env="local" draftId="d3" className="mt-3" />
        {s === "line" ? <Evidence edits={GREET.edits} framed className="mt-1" /> : null}
      </div>
    );
  return (
    <Page title="Purdue Esports" description="/home/work/Purdue Esports">
      <HouseRules workspace={workspace} />
    </Page>
  );
}
