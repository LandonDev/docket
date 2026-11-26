// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { request, opens } = vi.hoisted(() => ({
  request: vi.fn((method: string) =>
    Promise.resolve(method === "batch.board" ? { state: { masterId: "m", steps: [] }, children: [], digests: {} } : null),
  ),
  opens: [] as (() => void)[],
}));

vi.mock("../../../lib/connection", () => ({
  registry: {
    link: () => ({
      request,
      onOpen: (l: () => void) => (opens.push(l), () => undefined),
      onPush: () => () => undefined,
    }),
  },
}));

import { PaneVisibilityContext } from "../../../hooks/paneVisibility";
import { BOARD_RENEW_MS, BoardDigests, useBoard, useFarDigests } from "./useMasterModel";

const asked = (method: string) => request.mock.calls.filter((c) => c[0] === method).length;

function mount(hook: () => unknown) {
  let visible = true;
  const wrapper = ({ children }: { children: ReactNode }) => createElement(PaneVisibilityContext.Provider, { value: visible }, children);
  const view = renderHook(hook, { wrapper });
  return {
    show: (next: boolean) => {
      visible = next;
      view.rerender();
    },
    unmount: view.unmount,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  request.mockClear();
  opens.length = 0;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("park and unpark with nothing changed asks no batch.board; a show past the renew asks once", async () => {
  const board = mount(() => useBoard("m", "box"));
  expect(asked("batch.board")).toBe(1);
  for (let i = 0; i < 3; i++) {
    await act(async () => board.show(false));
    await act(() => vi.advanceTimersByTimeAsync(1000));
    await act(async () => board.show(true));
  }
  expect(asked("batch.board")).toBe(1);
  expect(asked("batch.get")).toBe(0);
  // Parked past the host's watch: the next show asks again, once.
  await act(async () => board.show(false));
  await act(() => vi.advanceTimersByTimeAsync(BOARD_RENEW_MS));
  expect(asked("batch.board")).toBe(1);
  await act(async () => board.show(true));
  expect(asked("batch.board")).toBe(2);
  // Shown, it renews on its timer.
  await act(() => vi.advanceTimersByTimeAsync(BOARD_RENEW_MS));
  expect(asked("batch.board")).toBe(3);
  board.unmount();
});

it("a new socket while parked asks on the next show, not before", async () => {
  const board = mount(() => useBoard("m", "box"));
  await act(async () => board.show(false));
  act(() => opens.forEach((l) => l()));
  expect(asked("batch.board")).toBe(1);
  await act(async () => board.show(true));
  expect(asked("batch.board")).toBe(2);
  board.unmount();
});

it("the far hosts' digests ask on show alone too", async () => {
  const digests = new BoardDigests();
  const far = mount(() => useFarDigests("m", "mac\npc", digests));
  expect(asked("batch.board")).toBe(2);
  await act(async () => far.show(false));
  await act(async () => far.show(true));
  expect(asked("batch.board")).toBe(2);
  far.unmount();
});
