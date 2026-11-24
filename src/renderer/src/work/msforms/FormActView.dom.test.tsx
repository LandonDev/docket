// @vitest-environment jsdom
/** A held Microsoft form make or publish: the form in words as people will see it, and no id, digest or raw settings. */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ACT_VIEWS } from "../acts/registry";
import { View } from "./FormActView";

afterEach(cleanup);

const settings = { accepting: false, orgOnly: true, recordName: true, onePerPerson: true };
const content = 'Spring LAN sign-up\n\n1. Text "Name", required\n2. Choice "Game" with Valorant, Rocket League\n\nOnly people in the organization can answer, signed in; their names are recorded; one answer each';

describe("the Microsoft form's view", () => {
  it("is the msforms pillar's own view of both kinds", () => {
    expect(ACT_VIEWS["msform.make"].chunk).not.toBeNull();
    expect(ACT_VIEWS["msform.publish"].chunk).toBe(ACT_VIEWS["msform.make"].chunk);
  });

  it("draws a publish as the form in words, whole, and nothing the host keeps", () => {
    const payload = { workspaceId: "ws_1", formId: "FORM_abc", rev: 3, title: "Spring LAN sign-up", act: "collect", settings, content, basis: "f".repeat(64) };
    const { container } = render(<View item={{ kind: "msform.publish", payload } as never} env="box" />);
    expect(container.querySelector('[data-slot="act-payload"]')!.textContent).toBe(content);
    expect(container.textContent).not.toMatch(/ws_1|FORM_abc|ffff|accepting/);
  });

  it("draws a make the same way, the folder in its words", () => {
    const made = `${content}\n\nMade in RecWell › Documents › Esports. In a Team's folder its members can see the form as soon as it is made.`;
    const payload = { workspaceId: "ws_1", sessionId: "s1", folder: { libraryId: "lib_1", path: "Esports", siteUrl: "https://x.sharepoint.com/sites/RecWell" }, title: "Spring LAN sign-up", description: "", questions: [], settings, collect: true, content: made };
    const { container } = render(<View item={{ kind: "msform.make", payload } as never} env="box" />);
    expect(container.textContent).toBe(made);
    expect(container.textContent).not.toMatch(/lib_1|sharepoint/);
  });

  it("takes the generic view when it holds no words", () => {
    const { container } = render(<View item={{ kind: "msform.publish", payload: "not a payload" } as never} env="box" />);
    expect(container.textContent).toBe("Its details could not be read.");
  });
});
