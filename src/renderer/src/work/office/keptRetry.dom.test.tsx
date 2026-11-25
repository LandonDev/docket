// @vitest-environment jsdom
/**
 * Settings' office rows read from a host (useHostRead): his Retry on a read that failed keeps the failed line in place,
 * its Retry spinning, never the row's bones, until the answer replaces it.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Link } from "../../lib/connection/link";
import { registry } from "../../lib/connection";
import { AddinRow } from "./AddinRow";
import { TeamsCopyRow } from "./TeamsCopyRow";
import { TeamsFilesRow } from "./TeamsFilesRow";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** A link whose read fails once, then waits for the test's answer. */
function failsThenWaits(method: string) {
  let answer!: (value: unknown) => void;
  let asked = 0;
  const link = {
    environmentId: "env_box",
    connected: true,
    onOpen: () => () => {},
    request: (m: string) => {
      if (m !== method) return Promise.reject(new Error(`unexpected ${m}`));
      return asked++ === 0 ? Promise.reject(new Error("The box did not answer.")) : new Promise((resolve) => (answer = resolve));
    },
  } as unknown as Link;
  return { link, answer: (value: unknown) => answer(value) };
}

async function pressAndHold(): Promise<void> {
  const retry = await screen.findByRole("button", { name: "Retry" });
  const line = document.body.textContent;
  await act(async () => fireEvent.click(retry));
  const held = screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement;
  expect(held.disabled).toBe(true);
  expect(held.querySelector("[data-busy]")).not.toBeNull();
  expect(document.querySelector('[data-slot="skeleton"]')).toBeNull();
  expect(document.body.textContent).toBe(line);
}

describe("his Retry on a row whose read failed", () => {
  it("keeps the paired add-ins' failure with Retry spinning until the list answers", async () => {
    const host = failsThenWaits("work.office.addin.list");
    render(<AddinRow link={host.link} title="Office add-ins" />);
    await pressAndHold();
    await act(async () => host.answer({ keys: [] }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Retry" })).toBeNull());
  });

  it("keeps the Teams copy switch's failure with Retry spinning until it answers", async () => {
    const host = failsThenWaits("work.office.filesCopyGet");
    vi.spyOn(registry, "linkOf").mockReturnValue(host.link as never);
    render(<TeamsCopyRow workspace={{ id: "w", environmentId: "env_box" }} hostName="the box" desktops={["MacBook Pro"]} />);
    await pressAndHold();
    await act(async () => host.answer({ on: false }));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Copy Teams files to the box" })).toBeTruthy());
  });

  it("keeps the folders' failure with Retry spinning until the host lists them", async () => {
    const host = failsThenWaits("work.office.filesLibraries");
    render(<TeamsFilesRow link={host.link} title="Folders" editable={false} />);
    await pressAndHold();
    await act(async () => host.answer({ libraries: [], roots: [], off: [] }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Retry" })).toBeNull());
  });
});
