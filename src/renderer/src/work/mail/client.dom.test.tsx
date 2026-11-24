// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { createElement, type PropsWithChildren } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { ThreadSummary } from "work-kit/mail";
import { beginRevealNavigation } from "../../lib/revealRead";
import { MailReadThread, mailClientFor } from "./client";

const markRead = vi.hoisted(() => vi.fn());
vi.mock("work-kit/lifeos", () => ({
  createLifeosMailClient: () => ({ useMailActions: () => ({ markRead }) }),
}));

const thread = { id: "m1" } as ThreadSummary;
beforeEach(() => markRead.mockClear());

function reader() {
  let open: string | null = thread.id;
  const actions = renderHook(() => mailClientFor("local", "", "all").useMailActions(), {
    wrapper: ({ children }: PropsWithChildren) => createElement(MailReadThread.Provider, { value: open }, children),
  });
  const target = new EventTarget();
  const listen = vi.spyOn(target, "addEventListener");
  beginRevealNavigation(target, "mail")();
  return {
    actions: () => actions.result.current,
    leave() { open = "m2"; actions.rerender(); },
    press() {
      const input = listen.mock.calls.find(([kind]) => kind === "pointerdown")?.[1] as EventListener;
      input({ isTrusted: true } as Event);
    },
  };
}

it("replays the held quiet mark on local input while that mail is still open", () => {
  const r = reader();
  r.actions().markRead(thread, true, true);
  expect(markRead).not.toHaveBeenCalled();
  r.press();
  expect(markRead.mock.calls).toEqual([[thread, true, true]]);
});

it("drops a held quiet mark when the reader moves to another mail", () => {
  const r = reader();
  r.actions().markRead(thread, true, true);
  r.leave();
  r.press();
  expect(markRead).not.toHaveBeenCalled();
});

it("keeps an explicit read decision instead of replaying an older quiet mark", () => {
  const r = reader();
  r.actions().markRead(thread, true, true);
  r.actions().markRead(thread, false);
  r.press();
  expect(markRead.mock.calls).toEqual([[thread, false, undefined]]);
});
