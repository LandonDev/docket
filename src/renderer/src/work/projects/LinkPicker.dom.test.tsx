// @vitest-environment jsdom
/** Link a document: a list that did not come says so in his words with Retry, and keeps what he typed. */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registry } from "../../lib/connection";
import { LinkPicker } from "./LinkPicker";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const DOC = { key: "d1", title: "Spring budget", kind: "doc", where: "lifeos", source: { at: "lifeos", table: "docs", id: "d1" } };

describe("LinkPicker", () => {
  it("words a failed list with Retry, which asks again and keeps the query", async () => {
    let fail = true;
    const request = vi.fn(async (method: string) => {
      if (method !== "work.docs.find") throw new Error("unexpected");
      if (fail) throw new Error("work.docs.find: EIO at /srv/agents/.tc/docs");
      return { entries: [DOC] };
    });
    vi.spyOn(registry, "linkOf").mockReturnValue({ environmentId: "env_box", request } as never);
    await act(async () => void render(<LinkPicker env="env_box" workspaceId="w" project={{ id: "p", name: "Spring LAN" }} kind="document" onClose={() => {}} />));
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("could not list what to link.");
    expect(alert.textContent).not.toContain("docs.find");
    const field = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "spring" } });
    fail = false;
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry" })));
    expect(request).toHaveBeenCalledTimes(2);
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("spring");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("option", { name: /Spring budget/ })).toBeTruthy();
  });

  it("says a refused link in his words, never the link's text", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "work.docs.find") return { entries: [DOC] };
      throw new Error("work.projects.link: forbidden at /srv/agents/.tc");
    });
    vi.spyOn(registry, "linkOf").mockReturnValue({ environmentId: "env_box", request } as never);
    await act(async () => void render(<LinkPicker env="env_box" workspaceId="w" project={{ id: "p", name: "Spring LAN" }} kind="document" onClose={() => {}} />));
    await act(async () => fireEvent.click(screen.getByRole("option", { name: /Spring budget/ })));
    expect(document.body.textContent).toContain("did not link it.");
    expect(document.body.textContent).not.toContain("projects.link");
  });
});
