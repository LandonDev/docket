import type { FormListRow, MsFormView } from "@shared/contract-work-msforms";
import { JOB, standUpView, ViewAt } from "../kit.preview";
import { ListChecks } from "../../chrome/icons";
import { NewFormPress, View } from "./FormsView";

/**
 * The Forms view as the column opens it, over a stand-in host, for `bun run ui:preview
 * src/renderer/src/work/msforms/FormsView.preview.tsx#FormsPreview --props '{"state":"list"}'`: both kinds of form,
 * newest first (`list`); neither list answered (`failed`); Microsoft's list did not answer, ours did (`partly`); and a
 * Microsoft form being made from New form, its press saying the make's stage (`making`). Rendered by nothing in the app.
 */

type State = "list" | "failed" | "partly" | "making";

const HOUR = 3_600_000;
const NOW = Date.now();

const OURS: FormListRow[] = [
  { kind: "ours", id: "item1", title: "Volunteer sign-up", state: "draft", count: null, lastAnswerAt: null, updatedAt: NOW - 3 * HOUR },
  { kind: "ours", id: "item2", title: "Spring LAN registration", state: "open", count: 38, lastAnswerAt: NOW - 2 * HOUR, updatedAt: NOW - 2 * HOUR },
];
const ms = (formId: string, title: string, state: string, count: number, at: number): MsFormView => ({ formId, tenant: "purdue0", title, state, count, lastAnswerAt: count ? at : null, updatedAt: at }) as unknown as MsFormView;
const MS = [ms("f1", "Spring intramurals", "collecting", 12, NOW - HOUR), ms("f2", "Coach check-in, week 9", "closed", 1, NOW - 30 * HOUR)];

const PLACES = {
  host: "local",
  rev: 1,
  sources: [],
  places: [{ id: "t1", kind: "teams", name: "Forms", group: "Esports Team", host: "This Mac", env: "local", shared: true, can: [], state: "ready", root: { at: "file", host: "local", path: "/Teams/Esports Team/Forms" } }],
};

const refused = (): never => {
  throw new Error("The host did not answer");
};

function stand(state: State): void {
  standUpView("forms", {}, (method) => {
    if (method === "work.forms.list") return state === "failed" ? refused() : OURS;
    if (method === "work.msforms.list") return state === "failed" || state === "partly" ? refused() : { forms: MS, offered: true };
    if (method === "work.files.places") return PLACES;
    return undefined;
  });
}

let stood: State | null = null;

export function FormsPreview({ state = "list" }: { state?: State }) {
  if (stood !== state) {
    stand(state);
    stood = state;
  }
  if (state === "making") return <Making />;
  return <ViewAt view="forms" height={420} />;
}

/**
 * A make in flight: the list under a header whose New form spins with the make's stage. The press is the view's own
 * (`NewFormPress`); the header around it is drawn here, since the frame's Head keeps its make to itself and a static
 * page cannot open the menu's submenu to start one.
 */
function Making() {
  return (
    <div className="relative flex w-full flex-col overflow-hidden rounded-lg border border-border bg-background" style={{ maxWidth: 864, height: 420 }}>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border ps-4 pe-2 text-[13px] font-medium">
        <ListChecks className="size-3.5 text-muted-foreground" />
        <span className="min-w-0 flex-1">Forms</span>
        <NewFormPress making stage="Adding the questions…" />
      </div>
      <div className="min-h-0 flex-1">
        <View env="local" workspace={JOB as never} sector={JOB.sector} lifeos={{} as never} startThread={() => undefined} />
      </div>
    </div>
  );
}
