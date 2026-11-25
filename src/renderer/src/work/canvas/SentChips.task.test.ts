import { afterEach, describe, expect, it } from "vitest";
import { openWorkView, workViewNow } from "../../lib/workSwitch";
import { openerOf } from "./SentChips";

/** A task chip in a sent message opens that task's sheet in Tasks, not the bare Tasks view. */
describe("a sent task chip", () => {
  const at = { environmentId: "box", sessionId: "t1", workspaceId: "ws" };
  afterEach(() => openWorkView(null));

  it("opens Tasks on the task", () => {
    void openerOf({ noun: "task", label: "Count the patch cables", ref: "LifeOS tasks k_41" } as never, at)!();
    expect(workViewNow()).toEqual({ workspaceId: "ws", view: "tasks", task: "k_41" });
  });

  it("a mail or an event still opens its own view as before", () => {
    void openerOf({ noun: "event", label: "Board meeting", ref: "LifeOS events e_1" } as never, at)!();
    expect(workViewNow()).toEqual({ workspaceId: "ws", view: "agenda" });
  });
});
