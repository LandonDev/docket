// @vitest-environment jsdom
/** The frame's feeds (frame.ts): what a kind says through its shell, kept for the item shown and for no other. */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { SavedLine } from "./kind";
import { useFrame } from "./frame";
import { canvasItem } from "./testkit";

afterEach(cleanup);

describe("the saved feed", () => {
  const DOC = canvasItem("doc");
  const SHEET = canvasItem("sheet", { kind: "sheet" });

  it("keeps what the kind last said of saving, and null takes it back", () => {
    const { result } = renderHook(() => useFrame("local", "t1", DOC));
    expect(result.current.feeds.saved).toBeNull();
    const saved: SavedLine = { state: "saved", at: 1_700_000_000_000, where: "Events" };
    act(() => result.current.shell.saved!(saved));
    expect(result.current.feeds.saved).toBe(saved);
    const offline: SavedLine = { state: "offline", pending: 3, actions: [{ id: "retry", label: "Retry", run: () => undefined }] };
    act(() => result.current.shell.saved!(offline));
    expect(result.current.feeds.saved).toBe(offline);
    act(() => result.current.shell.saved!(null));
    expect(result.current.feeds.saved).toBeNull();
  });

  it("belongs to one item: another item starts from nothing, and a late call from the one that left is dropped", () => {
    const { result, rerender } = renderHook(({ item }) => useFrame("local", "t1", item), { initialProps: { item: DOC } });
    const first = result.current.shell;
    act(() => first.saved!({ state: "saving" }));
    rerender({ item: SHEET });
    expect(result.current.feeds.saved).toBeNull();
    act(() => first.saved!({ state: "saved", at: 1 }));
    expect(result.current.feeds.saved).toBeNull();
  });

  it("takes a save line for a mail's file too: read only is the frame's to say, and a kind may still say more", () => {
    const mail = canvasItem("att", { kind: "pdf", source: { at: "mail", threadId: "t", messageId: "m", partId: "p", name: "a.pdf" } });
    const { result } = renderHook(() => useFrame("local", "t1", mail));
    act(() => result.current.shell.saved!({ state: "readonly", detail: "a mail's file" }));
    expect(result.current.feeds.saved?.state).toBe("readonly");
  });
});
