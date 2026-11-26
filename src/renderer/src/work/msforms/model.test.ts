import { describe, expect, it } from "vitest";
import type { FormListRow, MsFormView } from "@shared/contract-work-msforms";
import { mergeForms, rowLine } from "./model";

const ours = (id: string, updatedAt: number): FormListRow => ({ kind: "ours", id, title: `Ours ${id}`, state: "draft", count: null, lastAnswerAt: null, updatedAt });
const ms = (formId: string, updatedAt: number, o: Partial<MsFormView> = {}) => ({ formId, title: `MS ${formId}`, state: "collecting", count: 12, lastAnswerAt: null, updatedAt, ...o }) as MsFormView;

describe("the Forms view's list", () => {
  it("merges ours and Microsoft's, newest change first", () => {
    const rows = mergeForms([ours("a", 10), ours("b", 30)], [ms("x", 20), ms("y", 40)]);
    expect(rows.map((r) => `${r.kind}:${r.id}`)).toEqual(["ms:y", "ours:b", "ms:x", "ours:a"]);
  });

  it("says kind, state, count and last answer in one line", () => {
    expect(rowLine({ ...mergeForms([], [ms("x", 1, { lastAnswerAt: 5 })])[0]! }, () => "2:14 PM")).toBe("Microsoft, collecting, 12 responses, 2:14 PM");
    expect(rowLine(ours("a", 1), () => "")).toBe("Docket, draft");
  });
});
