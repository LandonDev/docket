// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MailClientProvider, MailKitProvider, opening } from "work-kit/mail";
import { createFixtureMailClient } from "work-kit/mail/fixtures";
import { registry } from "../../lib/connection/registry";
import { IDLE_STATUS, type EnvironmentStatus } from "../../lib/connection/types";
import { MailScreen, patch } from "./MailView";
import { tempcodeMailKit } from "./kit";

vi.mock("../canvas/CanvasSeat", () => ({ CanvasSeat: ({ children }: { children: ReactNode }) => children }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("holds Send and its menu on a lost host link and restores both when it opens", async () => {
  const listeners = new Set<() => void>();
  let transport: EnvironmentStatus["transport"] = "open";
  vi.spyOn(registry, "subscribe").mockImplementation((listener) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  });
  vi.spyOn(registry, "statusOf").mockImplementation(() => ({ ...IDLE_STATUS, transport }));
  vi.spyOn(registry, "environment").mockReturnValue({ id: "box", name: "the box" } as ReturnType<typeof registry.environment>);
  const client = createFixtureMailClient({ instant: true, write: async ({ run }) => run() });
  const id = "send-held-test";
  patch(id, { compose: opening({ open: { kind: "new" }, full: true }) });
  render(
    <MailClientProvider client={client}>
      <MailKitProvider kit={tempcodeMailKit}>
        <MailScreen id={id} onOpenTask={() => {}} files={{ env: "box", onAsk: () => {} }} />
      </MailKitProvider>
    </MailClientProvider>,
  );
  const send = () => screen.getByRole<HTMLButtonElement>("button", { name: "Send", exact: true });
  const menu = () => screen.getByRole<HTMLButtonElement>("button", { name: "More ways to send" });
  await screen.findByRole("button", { name: "Send", exact: true });
  expect(send().disabled).toBe(false);
  expect(menu().disabled).toBe(false);
  act(() => {
    transport = "offline";
    for (const notify of listeners) notify();
  });
  expect(send().disabled).toBe(true);
  expect(menu().disabled).toBe(true);
  const tip = send().parentElement!;
  expect(tip.getAttribute("aria-label")).toMatch(/box is offline/i);
  expect(tip.tabIndex).toBe(0);
  fireEvent.click(send());
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Subject" }), { key: "Enter", ctrlKey: true });
  expect(screen.queryByRole("alert")).toBeNull();
  act(() => {
    transport = "open";
    for (const notify of listeners) notify();
  });
  expect(send().disabled).toBe(false);
  expect(menu().disabled).toBe(false);
});
