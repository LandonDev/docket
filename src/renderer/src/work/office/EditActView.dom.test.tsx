// @vitest-environment jsdom
/** An agent's held change to a shared Word document or deck: each change as the words before and after. */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ACT_VIEWS } from "../acts/registry";
import { View } from "./EditActView";

afterEach(cleanup);
const show = (payload: unknown) => render(<View item={{ kind: "office.edit", payload } as never} env="mac" />);
const changes = (el: HTMLElement) => [...el.querySelectorAll("[data-change]")] as HTMLElement[];

describe("the office change's view", () => {
  it("is the office pillar's own view of office.edit", () => {
    expect(ACT_VIEWS["office.edit"].chunk).not.toBeNull();
  });

  it("draws a replace as the app, then the words struck and the words after, and no key, host or hash", () => {
    const p = { host: "env_mac", app: "word", key: "/Users/l/OneDrive-Purdue/Brief.docx", name: "Brief.docx", edit: { find: "We ship in March", replace: "We ship in May" }, places: 1, base: "abc" };
    const { container } = show(p);
    expect([...container.querySelectorAll("dt")].map((d) => d.textContent)).toEqual(["In"]);
    expect(container.querySelector("dd")!.textContent).toBe("Word");
    const [one] = changes(container);
    expect(one!.querySelector("del")!.textContent).toBe("Replace: We ship in March");
    expect(one!.querySelector("ins")!.textContent).toBe("With: We ship in May");
    expect(container.textContent).not.toMatch(/OneDrive|env_mac|abc/);
    expect(container.querySelector('[data-slot="act-payload"]')).toBeTruthy();
  });

  it("says where a deck's replace reaches above it, and a take-out has no words after", () => {
    const deck = show({ app: "powerpoint", vm: true, name: "Pitch.pptx", places: 2, on: [2, 5], edit: { find: "Q1", replace: "Q2" } }).container;
    expect(deck.querySelector("dd")!.textContent).toBe("PowerPoint in the Windows VM");
    expect(changes(deck)[0]!.querySelector("p")!.textContent).toBe("2 places on slides 2 and 5");
    cleanup();
    const out = show({ app: "word", name: "Brief.docx", places: 1, edit: { find: "draft", replace: "" } }).container;
    expect(changes(out)[0]!.querySelector("del")!.textContent).toBe("Take out: draft");
    expect(changes(out)[0]!.querySelector("ins")).toBeNull();
  });

  it("draws an insert as where it goes and its words, words with nothing to see by their escapes", () => {
    const { container } = show({ app: "word", name: "Brief.docx", edit: { insert: "​", at: "end" } });
    const [one] = changes(container);
    expect(one!.querySelector("p")!.textContent).toBe("At the end");
    expect(one!.querySelector("del")).toBeNull();
    expect(one!.querySelector("ins")!.textContent).toBe('Add: "\\u200b"');
  });

  it("quotes words that read alike with their escapes, as the rows do", () => {
    const { container } = show({ app: "word", name: "Brief.docx", places: 1, edit: { find: "a  b", replace: "a b" } });
    expect(container.querySelector("del")!.textContent).toBe('Replace: "a  b"');
    expect(container.querySelector("ins")!.textContent).toBe('With: "a b"');
  });

  it("takes the generic view when there is no change to draw", () => {
    const { container } = show("not a payload");
    expect(container.textContent).toBe("Its details could not be read.");
  });
});
