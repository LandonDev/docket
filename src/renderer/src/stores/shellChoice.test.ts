import { describe, expect, it } from "vitest";
import { choose, stillChosen } from "../lib/workSwitch";
import { shell } from "./shell";

/** Opening a page above the Work workspaces is his latest choice: a door still waiting on a host no longer takes the window. */
describe("a Work place opened", () => {
  it("advances the choice, so an older door's wait no longer counts", () => {
    const mine = choose();
    expect(stillChosen(mine, null, "")).toBe(true);
    shell.openWorkPlace("today");
    expect(stillChosen(mine, null, "")).toBe(false);
    shell.openWorkPlace(null);
  });
});
