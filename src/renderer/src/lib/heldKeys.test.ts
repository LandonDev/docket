// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { holdKeys, installHeldKeys } from "./heldKeys";

describe("the held keyboard", () => {
  it("hands the held element's keys over before any later capture listener, and stands down when let go", () => {
    installHeldKeys(window);
    const later = vi.fn();
    window.addEventListener("keydown", later, true);
    const el = document.createElement("div");
    const other = document.createElement("div");
    document.body.append(el, other);
    const take = vi.fn();
    const undo = holdKeys(el, take);
    el.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyS", metaKey: true, bubbles: true }));
    el.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyS", bubbles: true }));
    expect(take.mock.calls.map(([e]) => (e as KeyboardEvent).type)).toEqual(["keydown", "keyup"]);
    expect(later).not.toHaveBeenCalled();
    // another element's keys are not the picture's
    other.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyS", bubbles: true }));
    expect(later).toHaveBeenCalledOnce();
    // a hold that was replaced does not undo the new one
    const next = vi.fn();
    const undoNext = holdKeys(el, next);
    undo();
    el.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyA", bubbles: true }));
    expect(next).toHaveBeenCalledOnce();
    undoNext();
    el.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyA", bubbles: true }));
    expect(later).toHaveBeenCalledTimes(2);
    window.removeEventListener("keydown", later, true);
  });
});
