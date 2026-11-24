import { describe, expect, it, vi } from "vitest";
import type { MsFormView } from "@shared/contract-work-msforms";
import type { TodayWorkspace } from "../today/types";

const opened: unknown[] = [];
vi.mock("../files/openFrom", () => ({ openInFiles: async (workspace: unknown, what: unknown) => void opened.push([workspace, what]) }));
vi.mock("../canvas/frame", () => ({ sayError: () => {} }));
vi.mock("../today/read", () => ({ useEachWorkspace: () => ({ answers: [], loading: false, failed: [] }), readState: () => ({}) }));

const { responseRows, source } = await import("./today");
const { TODAY_SOURCES } = await import("../today/sources");

const purdue: TodayWorkspace = { environmentId: "box", workspaceId: "ws-purdue", sector: "purdue", name: "Purdue Esports", path: "/work/Purdue", open: true };
const form = (over: Partial<MsFormView>): MsFormView => ({ formId: "f1", title: "Spring LAN sign-up", tenant: "purdue0", unseen: 0, lastAnswerAt: null, count: 0, ...over }) as unknown as MsFormView;

describe("Microsoft forms on Today", () => {
  it("is one of Today's sources: Responses at 70, folded past five, drawn only while a form has news", () => {
    expect(TODAY_SOURCES.map((s) => s.id)).toContain("msforms");
    expect(source.section).toEqual({ id: "msforms", title: "Responses", order: 70, empty: "", fold: 5 });
    expect(responseRows([{ workspace: purdue, value: { forms: [form({ count: 4 })] } }])).toEqual([]);
  });

  it("lists each form with unseen answers by its count, and opens it in its Files tab", () => {
    const rows = responseRows([{ workspace: purdue, value: { forms: [form({ unseen: 3, count: 7, lastAnswerAt: 1000 }), form({ formId: "f2", title: "Coach check-in", unseen: 1, count: 1 })] } }]);
    expect(rows.map(({ open: _open, ...r }) => r)).toEqual([
      { key: "msforms:box:ws-purdue:f1", section: "msforms", sector: "purdue", job: "Purdue Esports", title: "Spring LAN sign-up", detail: "3 new responses", at: 1000 },
      { key: "msforms:box:ws-purdue:f2", section: "msforms", sector: "purdue", job: "Purdue Esports", title: "Coach check-in", detail: "1 new response" },
    ]);
    rows[0]!.open!();
    expect(opened).toEqual([[{ id: "ws-purdue", environmentId: "box" }, { ref: { at: "msform", host: "box", workspaceId: "ws-purdue", formId: "f1", tenant: "purdue0" }, name: "Spring LAN sign-up" }]]);
  });
});
