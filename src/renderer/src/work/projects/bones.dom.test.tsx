// @vitest-environment jsdom
/**
 * Projects' bones (council round 1, sitting E, R1-E15; S9 "Seen, not fixed"): before the view's chunk lands the frame
 * drew six Tasks-shaped rows, also before a project's page. Projects names its own bones: the list's, or the page's its
 * kept place will show.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { bonesShape, PLACE_KEY, ProjectsBones } from "./bones";
import { projectsView } from "./view";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const keep = (places: Record<string, unknown>): void => localStorage.setItem(PLACE_KEY, JSON.stringify(places));

describe("Projects' bones", () => {
  it("take the kept place's shape: a project's page, a task's page, else the list", () => {
    keep({ a: { at: "project", id: "p1", layout: "list", tab: "plan" }, b: { at: "task", id: "t1", layout: "list", tab: "plan" }, c: { at: "list", layout: "list", tab: "plan" }, d: { at: "project", layout: "list", tab: "plan" } });
    expect(bonesShape("a")).toBe("project");
    expect(bonesShape("b")).toBe("task");
    expect(bonesShape("c")).toBe("list");
    // A page with nothing to show comes back as the list (place.ts `parsePlace`), and so do its bones.
    expect(bonesShape("d")).toBe("list");
    expect(bonesShape("none")).toBe("list");
    localStorage.setItem(PLACE_KEY, "{not json");
    expect(bonesShape("a")).toBe("list");
  });

  it("are what the frame draws while the view's chunk loads", () => {
    keep({ ws: { at: "project", id: "p1", layout: "list", tab: "plan" } });
    const { container } = render(<>{projectsView.bones!({ id: "ws" } as never)}</>);
    const page = container.querySelector('[data-bones="project"]')!;
    expect(page.getAttribute("aria-label")).toBe("Loading the project");
    // The title, the facts line and two of brief, then a section's head over its rows: no Tasks-shaped row of two lines.
    expect(page.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(4 + 1 + 4 * 2);
    expect(page.querySelectorAll(".rounded-full")).toHaveLength(4);
    cleanup();
    keep({});
    const list = render(<ProjectsBones shape={bonesShape("ws")} />).container;
    expect(list.querySelector('[data-bones="list"]')?.getAttribute("aria-label")).toBe("Loading Projects");
  });
});
