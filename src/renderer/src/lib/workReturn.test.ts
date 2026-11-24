// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { returnOf } from "./workReturn";
import { forgetReturnWindow, keepReturn } from "../work/shell/returnRecord";

const KEY = "work.return.v1";

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  forgetReturnWindow(true);
});

describe("where he was in a Work workspace", () => {
  it("is nothing for a workspace never visited", () => {
    expect(returnOf("ws")).toEqual({});
  });

  it("keeps the view and the thread, and merges each view's place by its key", () => {
    keepReturn("ws", { view: "mail", thread: "t1" });
    keepReturn("ws", { places: { mail: { box: "sent" } } });
    keepReturn("ws", { places: { tasks: { task: "k1" } } });
    expect(returnOf("ws")).toEqual({ view: "mail", thread: "t1", places: { mail: { box: "sent" }, tasks: { task: "k1" } } });
    keepReturn("ws", { view: null, places: { tasks: undefined } });
    expect(returnOf("ws")).toEqual({ view: null, thread: "t1", places: { mail: { box: "sent" } } });
    expect(returnOf("other")).toEqual({});
  });

  it("survives a reload: the same window reads its own record", () => {
    keepReturn("ws", { view: "files" });
    forgetReturnWindow();
    expect(returnOf("ws").view).toBe("files");
  });

  it("a relaunch starts from the window that wrote last", () => {
    keepReturn("ws", { view: "files" });
    forgetReturnWindow(true);
    sessionStorage.clear();
    keepReturn("ws2", { view: "tasks" });
    forgetReturnWindow(true);
    sessionStorage.clear();
    expect(returnOf("ws2").view).toBe("tasks");
    expect(returnOf("ws").view).toBe("files");
  });

  it("each window keeps its own, a dozen at most", () => {
    for (let i = 0; i < 14; i++) {
      forgetReturnWindow(true);
      sessionStorage.clear();
      keepReturn("ws", { view: `v${i}` });
    }
    expect(Object.keys(JSON.parse(localStorage.getItem(KEY)!) as object)).toHaveLength(12);
  });

  it("a record it cannot read is nothing, never an error", () => {
    localStorage.setItem(KEY, "{not json");
    forgetReturnWindow(true);
    expect(returnOf("ws")).toEqual({});
    keepReturn("ws", { view: "mail" });
    expect(returnOf("ws").view).toBe("mail");
  });
});
