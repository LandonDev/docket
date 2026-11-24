// @vitest-environment jsdom
/** A held Google share: the person, what they can do, the account and Google's own mail, never the file id. */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ACT_VIEWS } from "../acts/registry";
import { View } from "./ShareActView";

afterEach(cleanup);

describe("the Google share's view", () => {
  it("is the google pillar's own view of share.google", () => {
    expect(ACT_VIEWS["share.google"].chunk).not.toBeNull();
  });

  it("draws its fields on the label column", () => {
    const payload = { account: "landon@x", fileId: "1AbC", name: "Budget.xlsx", email: "dana@purdue.edu", role: "commenter", notify: true };
    const { container } = render(<View item={{ kind: "share.google", payload } as never} env="box" />);
    const rows = [...container.querySelectorAll("dt")].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]);
    expect(rows).toEqual([
      ["Person", "dana@purdue.edu"],
      ["Access", "Can comment"],
      ["Account", "landon@x"],
      ["Notice", "Tells them by mail"],
    ]);
    expect(container.textContent).not.toContain("1AbC");
    expect(container.querySelector('[data-slot="act-payload"]')).toBeTruthy();
  });

  it("says once that a payload it cannot read could not be read", () => {
    const { container } = render(<View item={{ kind: "share.google", payload: null } as never} env="box" />);
    expect(container.textContent).toBe("Its details could not be read.");
  });
});
