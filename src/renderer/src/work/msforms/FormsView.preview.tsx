import { useEffect } from "react";
import type { FormListRow, MsFormView } from "@shared/contract-work-msforms";
import { standUpView, Unsettled, usePressNamed, ViewAt } from "../kit.preview";

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
    // The make runs on: its press keeps saying the stage it is at.
    if (method === "work.msforms.make") return new Promise(() => undefined);
    return undefined;
  });
}

/** Picks New form → Microsoft Form → the Teams folder, as his clicks would, once the menu has drawn each step. */
function useMakeOne(on: boolean): void {
  usePressNamed(on ? "New form" : null, 300);
  useEffect(() => {
    if (!on) return;
    const pick = (words: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((row) => row.textContent?.trim().startsWith(words))?.click();
    const sub = setTimeout(() => pick("Microsoft Form"), 600);
    const place = setTimeout(() => pick("Esports Team, Forms"), 900);
    return () => {
      clearTimeout(sub);
      clearTimeout(place);
    };
  }, [on]);
}

let stood: State | null = null;

export function FormsPreview({ state = "list" }: { state?: State }) {
  if (stood !== state) {
    stand(state);
    stood = state;
  }
  useMakeOne(state === "making");
  return (
    <>
      <ViewAt view="forms" height={420} />
      {state === "making" ? <Unsettled ms={1400} /> : null}
    </>
  );
}
