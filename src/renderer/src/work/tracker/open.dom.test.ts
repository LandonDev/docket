// @vitest-environment jsdom
/**
 * The tracker's New project (tracker/open.ts): the dialog opens over the job's list; Cancel, Escape or a press
 * outside (the kit sets the list) bring him back to the tracker; Create lands on the new project; a later New project
 * from the job's own list goes back to that list.
 */
import { afterEach, describe, expect, it } from "vitest";
import { LIST_PLACE } from "work-kit/projects";
import { openWorkView } from "../../lib/workSwitch";
import { shell, shellStore } from "../../stores/shell";
import { placeOf, resetPlaces, setPlace } from "../projects/place";
import { openNewProject } from "./open";

const tracker = () => shellStore.getState().workPlace;

afterEach(() => {
  resetPlaces();
  openWorkView(null);
  shell.openWorkPlace(null);
});

describe("the tracker's New project", () => {
  it("goes back to the tracker on a dismissal, once", () => {
    shell.openWorkPlace("projects");
    openNewProject("w-job");
    expect(tracker()).toBeNull();
    expect(placeOf("w-job").at).toBe("new");
    setPlace("w-job", LIST_PLACE);
    expect(tracker()).toBe("projects");
    // The job's own New project, later, leaves him on the job's list.
    shell.openWorkPlace(null);
    setPlace("w-job", { ...LIST_PLACE, at: "new" });
    setPlace("w-job", LIST_PLACE);
    expect(tracker()).toBeNull();
  });

  it("lands on the new project on Create", () => {
    openNewProject("w-job");
    setPlace("w-job", { at: "project", id: "p-new", layout: "list", tab: "all" });
    expect(tracker()).toBeNull();
    // A New project from the job's list after it keeps no return.
    setPlace("w-job", { ...LIST_PLACE, at: "new" });
    setPlace("w-job", LIST_PLACE);
    expect(tracker()).toBeNull();
  });
});
