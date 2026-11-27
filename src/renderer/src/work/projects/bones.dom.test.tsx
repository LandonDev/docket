// @vitest-environment jsdom
/**
 * Projects' bones (council round 1, sitting E, R1-E15; S9 "Seen, not fixed"): before the view's chunk lands the frame
 * drew six Tasks-shaped rows, also before a project's page. Projects names its own bones: the list's, or the page's its
 * kept place will show.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { bonesShape, PLACE_KEY, ProjectsBones, SAMPLE_PROJECT_PAGE, SAMPLE_PROJECT_ROWS, SAMPLE_TASK_PAGE } from "./bones";
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
    const page = container.querySelector('[data-projects-bones="project"]')!;
    expect(page.getAttribute("aria-label")).toBe("Loading the project");
    // Skullet's bones, drawn from the sample page: its name, its facts line and brief, Plan's rows each with its glyph.
    expect(page.querySelector("[data-region][data-bones]")).not.toBeNull();
    const drawing = page.querySelector("[skullet-loading]")!;
    expect(drawing.textContent).toContain(SAMPLE_PROJECT_PAGE.name);
    expect(drawing.textContent).toContain(SAMPLE_PROJECT_PAGE.plan[3]!.title);
    expect(drawing.querySelectorAll("[data-bone].rounded-full")).toHaveLength(SAMPLE_PROJECT_PAGE.plan.length);
    // No hand-drawn bar is left.
    expect(page.querySelector('[data-slot="skeleton"]')).toBeNull();
    cleanup();
    keep({});
    const list = render(<ProjectsBones shape={bonesShape("ws")} />).container;
    expect(list.querySelector('[data-projects-bones="list"]')?.getAttribute("aria-label")).toBe("Loading Projects");
    expect(list.querySelector("[skullet-loading]")?.textContent).toContain(SAMPLE_PROJECT_ROWS[0]!.name);
    cleanup();
    keep({ ws: { at: "task", id: "t1", layout: "list", tab: "plan" } });
    const task = render(<ProjectsBones shape={bonesShape("ws")} />).container;
    expect(task.querySelector('[data-projects-bones="task"] [skullet-loading]')?.textContent).toContain(SAMPLE_TASK_PAGE.title);
  });
});
