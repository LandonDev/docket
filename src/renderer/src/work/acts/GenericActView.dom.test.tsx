// @vitest-environment jsdom
/** The generic act view: a computer act's tool word is left out under its title; its URL is labelled so. */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { GenericActView } from "./GenericActView";

afterEach(cleanup);

describe("a computer act in the generic view", () => {
  it("leaves out the tool's action word and labels the url URL", () => {
    const payload = { tool: "browser", args: { action: "left_click", url: "https://arbiter.example/submit" }, app: { name: "Arbiter", bundleId: null }, window: "Submit", why: "screen", label: "Submit", title: "Click Submit in Arbiter", read: null, picture: null, mark: "m", targets: [] };
    const { container } = render(<GenericActView item={{ kind: "computer.act", payload } as never} env="mac" />);
    const labels = [...container.querySelectorAll("dt")].map((d) => d.textContent);
    expect(labels).not.toContain("Action");
    expect(labels).toContain("URL");
    expect(container.textContent).not.toContain("left_click");
  });

  it("keeps an add-on call's action argument: there every key is what goes", () => {
    const { container } = render(<GenericActView item={{ kind: "addon.call", payload: { arguments: { action: "archive" } } } as never} env="mac" />);
    expect([...container.querySelectorAll("dt")].map((d) => d.textContent)).toContain("Action");
  });
});

describe("a kind with its own rows", () => {
  it("draws a Google share as Person, Access and Account, with no file id", () => {
    const payload = { account: "landon@x", fileId: "1AbC", name: "Budget.xlsx", email: "dana@purdue.edu", role: "commenter", notify: false };
    const { container } = render(<GenericActView item={{ kind: "share.google", payload } as never} env="box" />);
    expect([...container.querySelectorAll("dt")].map((d) => d.textContent)).toEqual(["Person", "Access", "Account"]);
    expect(container.textContent).toContain("Can comment");
    expect(container.textContent).not.toContain("1AbC");
  });
});
