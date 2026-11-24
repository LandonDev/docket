// @vitest-environment jsdom
/** A Work workspace's Teams copy switch: a failed save says what happened in his words, never the link's text. */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registry } from "../../lib/connection";
import { TeamsCopyRow } from "./TeamsCopyRow";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("TeamsCopyRow", () => {
  it("says a refused save in his words, with no method or path", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "work.office.filesCopyGet") return { on: false };
      throw new Error("work.office.filesCopySet: EIO at /srv/agents/.tc");
    });
    vi.spyOn(registry, "linkOf").mockReturnValue({ environmentId: "env_box", connected: true, request, onOpen: () => () => {} } as never);
    await act(async () => void render(<TeamsCopyRow workspace={{ id: "w", environmentId: "env_box" }} hostName="the box" desktops={["MacBook Pro"]} />));
    await act(async () => fireEvent.click(screen.getByRole("switch", { name: "Copy Teams files to the box" })));
    expect(screen.getByText("The computer did not save the change.")).toBeTruthy();
    expect(document.body.textContent).not.toContain("filesCopySet");
  });
});
