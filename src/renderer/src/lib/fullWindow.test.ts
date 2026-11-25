import { afterEach, describe, expect, it } from "vitest";
import { canFullScreen, closeFullWindow, fullWindowTarget, offerFullScreen, openFullWindow, subscribeFullWindow, toggleFullScreen } from "./fullWindow";

const stage = { host: "box", threadId: "vm:windows", name: "Windows VM" };

afterEach(() => closeFullWindow());

describe("full screen's store", () => {
  it("⌃⌘F takes the offered computer full screen with no motion, and leaves", () => {
    const told: number[] = [];
    const stop = subscribeFullWindow(() => told.push(1));
    expect(canFullScreen()).toBe(false);
    // nothing offered: the key does nothing
    toggleFullScreen();
    expect(fullWindowTarget()).toBeNull();
    const withdraw = offerFullScreen({ ...stage, from: { x: 0, y: 0, width: 10, height: 10 } });
    expect(canFullScreen()).toBe(true);
    toggleFullScreen();
    // a key's entry carries no place to grow from
    expect(fullWindowTarget()).toEqual(stage);
    toggleFullScreen();
    expect(fullWindowTarget()).toBeNull();
    withdraw();
    expect(canFullScreen()).toBe(false);
    expect(told.length).toBe(4);
    stop();
  });

  it("an offer taken back after another was made leaves the newer one", () => {
    const first = offerFullScreen(stage);
    const second = offerFullScreen({ ...stage, threadId: "t2" });
    first();
    toggleFullScreen();
    expect(fullWindowTarget()?.threadId).toBe("t2");
    second();
    // open, it can still be left
    expect(canFullScreen()).toBe(true);
  });

  it("a pressed picture keeps its place for the grow", () => {
    openFullWindow({ ...stage, from: { x: 4, y: 8, width: 640, height: 400 } });
    expect(fullWindowTarget()?.from).toEqual({ x: 4, y: 8, width: 640, height: 400 });
  });
});
