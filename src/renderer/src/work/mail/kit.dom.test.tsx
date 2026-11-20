// @vitest-environment jsdom
/** The mail kit's invitation card: Open in Agenda hands the event on, so Agenda can open on its week. */
import { afterEach, describe, expect, it } from "vitest";

const { tempcodeMailKit } = await import("./kit");
const { openWorkView, workViewNow } = await import("../../lib/workSwitch");

afterEach(() => openWorkView(null));

describe("Open in Agenda", () => {
  it("opens the workspace's Agenda with the invitation's event", () => {
    openWorkView({ workspaceId: "ws", view: "mail" });
    tempcodeMailKit.openEvent!("ev_1");
    expect(workViewNow()).toEqual({ workspaceId: "ws", view: "agenda", event: "ev_1" });
  });

  it("opens nothing with no view open", () => {
    tempcodeMailKit.openEvent!("ev_1");
    expect(workViewNow()).toBeNull();
  });
});
