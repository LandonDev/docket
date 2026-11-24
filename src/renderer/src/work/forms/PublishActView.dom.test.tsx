// @vitest-environment jsdom
/** A held form publish: how many questions, then the form in words, and never its item id or revision. */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ACT_VIEWS } from "../acts/registry";
import { View } from "./PublishActView";

afterEach(cleanup);

describe("the form publish's view", () => {
  it("is the forms pillar's own view of form.publish", () => {
    expect(ACT_VIEWS["form.publish"].chunk).not.toBeNull();
  });

  it("draws Questions on the label column and the form under a hairline, line breaks kept", () => {
    const content = "1. Name (short answer, required)\n2. Game (choice)\n   - Valorant\n   - Rocket League";
    const { container } = render(<View item={{ kind: "form.publish", payload: { itemId: "itm_1", title: "Spring LAN signup", rev: 4, questions: 2, content } } as never} env="box" />);
    expect([...container.querySelectorAll("dt")].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent])).toEqual([["Questions", "2"]]);
    const body = [...container.querySelectorAll("div")].find((d) => d.textContent === content)!;
    expect(body.className).toContain("whitespace-pre-wrap");
    expect(body.className).toContain("border-t");
    expect(container.textContent).not.toMatch(/itm_1/);
  });
});
