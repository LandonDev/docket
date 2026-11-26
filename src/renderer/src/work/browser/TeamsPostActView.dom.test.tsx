// @vitest-environment jsdom
/** A held Teams post in the Outbox: the post as he will see it, under the chat it lands in. */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ACT_VIEWS } from "../acts/registry";
import { UnderItsAct } from "../acts/underItsAct";
import { View } from "./TeamsPostActView";

afterEach(cleanup);
const show = (payload: unknown) => render(<View item={{ kind: "teams.post", payload } as never} env="mac" />);

describe("the Teams post's view", () => {
  it("is the browser pillar's own view of teams.post", () => {
    expect(ACT_VIEWS["teams.post"].chunk).not.toBeNull();
  });

  it("draws the post under its chat, his name over its words exactly, the chat said once", () => {
    const text = "Nationals bus leaves the Armory at 7:00 AM.\n\nChase anyone who hasn't confirmed.";
    const { container } = show({ chat: "Esports staff, General", text });
    expect(container.querySelector("[data-place]")!.textContent).toBe("Esports staff, General");
    const posted = container.querySelector("[data-posted]")!;
    expect(posted.textContent).toBe(`You${text}`);
    expect(container.textContent!.split("Esports staff").length - 1).toBe(1);
    expect(container.querySelector('[data-slot="act-payload"]')).toBeTruthy();
    expect(container.querySelector("dl")).toBeNull();
  });

  it("under a row that already says its act (the summary list opened in place) leaves the chat to the row", () => {
    const { container } = render(
      <UnderItsAct.Provider value>
        <View item={{ kind: "teams.post", payload: { chat: "Esports staff, General", text: "Bus at 7" } } as never} env="mac" />
      </UnderItsAct.Provider>,
    );
    expect(container.querySelector("[data-place]")).toBeNull();
    expect(container.textContent).not.toContain("Esports staff");
  });

  it("quotes words with nothing to see by their escapes, never a blank post", () => {
    const { container } = show({ chat: "Staff", text: "​" });
    expect(container.querySelector("[data-posted]")!.textContent).toBe('You"\\u200b"');
  });

  it("takes the generic view for any other shape, so nothing that goes is hidden", () => {
    const { container } = show({ chat: "Staff", text: "Hi", html: "<p>Hi <b>all</b></p>" });
    expect(container.querySelector("[data-posted]")).toBeNull();
    expect(container.textContent).toContain("Hi all");
    const broken = show("not a payload").container;
    expect(broken.textContent).toBe("Its details could not be read.");
  });
});
