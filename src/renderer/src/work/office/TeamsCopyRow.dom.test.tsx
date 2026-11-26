// @vitest-environment jsdom
/** A job's Teams copy switch: a refused save goes back with the row's red line in his words; off asks first. */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registry } from "../../lib/connection";

const confirm = vi.hoisted(() => ({ answer: true, asked: [] as { title: string; body: string }[] }));
vi.mock("../../chrome/ConfirmDialog", async (original) => ({
  ...(await original<object>()),
  confirmAction: async (request: { title: string; body: string }) => (confirm.asked.push(request), confirm.answer),
}));
const { TeamsCopyRow } = await import("./TeamsCopyRow");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  confirm.asked = [];
  confirm.answer = true;
});

const host = (on: boolean, set: (params: { on: boolean }) => Promise<unknown>) => {
  const request = vi.fn(async (method: string, params: { on: boolean }) => (method === "work.office.filesCopyGet" ? { on } : set(params)));
  vi.spyOn(registry, "linkOf").mockReturnValue({ environmentId: "env_box", connected: true, request, onOpen: () => () => {} } as never);
  return request;
};
const toggle = () => screen.getByRole("switch", { name: "Copy Teams files to the box" });

describe("TeamsCopyRow", () => {
  it("puts a refused save back and says why under the row, with no method or path", async () => {
    host(false, async () => {
      throw new Error("work.office.filesCopySet: EIO at /srv/agents/.tc");
    });
    await act(async () => void render(<TeamsCopyRow workspace={{ id: "w", environmentId: "env_box" }} computer="the box" />));
    await act(async () => fireEvent.click(toggle()));
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(toggle().closest('[data-setting="job.copy"]')?.textContent).not.toContain("filesCopySet");
    expect(toggle().closest('[data-setting="job.copy"]')?.querySelector(".text-destructive")).toBeTruthy();
  });

  it("asks before turning off, naming the copies it deletes, and Cancel writes nothing", async () => {
    const request = host(true, async (params) => params);
    confirm.answer = false;
    await act(async () => void render(<TeamsCopyRow workspace={{ id: "w", environmentId: "env_box" }} computer="the box" />));
    await act(async () => fireEvent.click(toggle()));
    expect(confirm.asked[0]?.body).toBe("The copies on the box are deleted. The files stay in Teams.");
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    expect(request.mock.calls.map((call) => call[0])).not.toContain("work.office.filesCopySet");
  });
});
