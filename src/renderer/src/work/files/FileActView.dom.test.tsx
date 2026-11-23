// @vitest-environment jsdom
/** A held file act in the Outbox: the files it names, where they are now, and where they go or the name they take. */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { FileAct } from "@shared/contract-work-files";
import { ACT_VIEWS } from "../acts/registry";
import { View } from "./FileActView";

afterEach(cleanup);

const base: FileAct = {
  workspaceId: "w1",
  host: "env_box",
  verb: "move",
  op: "act:1",
  request: { refs: [{ at: "file", host: "env_box", path: "/w/Budget.xlsx" }], to: { at: "file", host: "env_box", path: "/t/Events" } },
  digest: "d".repeat(64),
  things: [{ key: "k1", name: "Spring budget.xlsx", version: "1:1:" }],
  from: { place: "folder", name: "Dummy Esports", trail: ["Budgets"] },
  into: { place: "p", name: "Esports Staff, Events", trail: [], key: "k2" },
  audience: "Everyone in Esports Staff can open it.",
};
const show = (p: FileAct) => render(<View item={{ kind: "file.act", payload: p } as never} env="env_box" />);
const rows = () => [...document.querySelectorAll("dt")].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]);

describe("the file act's view", () => {
  it("is the files pillar's own view of file.act", () => {
    expect(ACT_VIEWS["file.act"].chunk).not.toBeNull();
  });

  it("lists a move's file with its glyph, where it is now and where it goes, and never a path", () => {
    show(base);
    expect(rows()).toEqual([
      ["File", "Spring budget.xlsx"],
      ["Now in", "Dummy Esports, Budgets"],
      ["Goes to", "Esports Staff, Events"],
    ]);
    expect(document.querySelector('[data-kind-glyph="sheet"]')).toBeTruthy();
    expect(document.body.textContent).not.toContain("/w/");
    expect(document.querySelector('[data-slot="act-payload"]')).toBeTruthy();
  });

  it("names a rename's new name, a make's file and where it is made, and several files as Files", () => {
    show({ ...base, verb: "rename", request: { refs: base.request.refs, name: "Plan v2.docx" }, into: undefined });
    expect(rows()).toEqual([
      ["File", "Spring budget.xlsx"],
      ["Now in", "Dummy Esports, Budgets"],
      ["New name", "Plan v2.docx"],
    ]);
    cleanup();
    show({ ...base, verb: "make", request: { refs: base.request.refs, kind: "text", name: "Agenda.txt" }, into: undefined, things: [{ key: "f", name: "General", version: "" }], from: { place: "g", name: "Esports Staff, General", trail: [] } });
    expect(rows()).toEqual([
      ["File", "Agenda.txt"],
      ["In", "Esports Staff, General"],
    ]);
    cleanup();
    show({ ...base, verb: "copy", things: [...base.things, { key: "k3", name: "Poster.png", version: "" }] });
    expect(rows()[0]).toEqual(["Files", "Spring budget.xlsxPoster.png"]);
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });
});
