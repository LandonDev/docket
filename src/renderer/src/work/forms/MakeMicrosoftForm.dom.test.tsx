// @vitest-environment jsdom
/**
 * Make this a Microsoft form in our form's More (MakeMicrosoftForm.tsx): offered where the host makes Microsoft
 * forms and the form has questions; its dialog picks a Teams or OneDrive place, and Make asks `work.msforms.make`
 * there with this form's title and questions as Forms' own, then opens the new form in its Files tab.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FormBody } from "@shared/contract-work-forms";
import type { MoreEntry } from "../canvas/kind";

const wire = vi.hoisted(() => ({ asked: [] as { env: string; method: string; params: unknown }[], offered: true, places: [] as unknown[], refuse: null as string | null, opened: [] as unknown[] }));
vi.mock("../../lib/connection", () => ({
  registry: {
    primaryEnvironmentId: "box",
    onLink: () => () => undefined,
    linkOf: (env: string) => ({
      request: async (method: string, params: unknown) => {
        wire.asked.push({ env, method, params });
        if (method === "work.msforms.list") return { forms: [], offered: wire.offered };
        if (method === "work.files.places") return { places: wire.places };
        if (wire.refuse) throw new Error(wire.refuse);
        return { formId: "Ob0wQVN8nEGx5YdY1tY_IQaWFXVrVqJAiq2zrvrF0001", tenant: "purdue0", title: "Tryouts" };
      },
    }),
  },
}));
vi.mock("../files/store", () => ({ openFileTab: async (...args: unknown[]) => void wire.opened.push(args), openMadeTab: async () => undefined }));

const { useMakeMicrosoftForm } = await import("./MakeMicrosoftForm");

const body: FormBody = {
  title: "Tryouts",
  description: "",
  questions: [
    { id: "a", label: "Name", type: "short", required: true },
    { id: "b", label: "Night", type: "dropdown", required: false, options: ["Mon", "Tue"] },
  ],
};
const place = (id: string, name: string, group?: string) => ({ id, name, group, kind: "teams", root: { at: "file", host: "box", path: `/Users/l/purdue.edu/${name}` } });

let row: MoreEntry | null = null;
function Seat({ b = body, workspaceId = "ws-purdue" }: { b?: FormBody | null; workspaceId?: string | null }) {
  const ms = useMakeMicrosoftForm({ env: "box", workspaceId, body: b });
  row = ms.row;
  return <>{ms.dialog}</>;
}
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

afterEach(() => {
  cleanup();
  wire.asked.length = 0;
  wire.opened.length = 0;
  wire.offered = true;
  wire.places = [];
  wire.refuse = null;
  row = null;
});

describe("Make this a Microsoft form", () => {
  it("is a row of More only where the host makes them, for a form with questions in a workspace", async () => {
    // (the host's word is kept per window and workspace: each case asks of its own)
    wire.offered = false;
    render(<Seat workspaceId="ws-off" />);
    await settle();
    expect(row).toBeNull();
    cleanup();
    wire.offered = true;
    render(<Seat workspaceId={null} />);
    await settle();
    expect(row).toBeNull();
    cleanup();
    render(<Seat b={{ ...body, questions: [] }} />);
    await settle();
    expect(row).toBeNull();
    cleanup();
    render(<Seat />);
    await settle();
    expect(row).toMatchObject({ id: "msform", label: "Make this a Microsoft form" });
  });

  it("makes the form at once in the place he picks, with its title and questions as Forms' own, then opens it", async () => {
    wire.places = [place("recwell", "Esports", "RecWell"), place("od", "OneDrive")];
    render(<Seat />);
    await settle();
    await act(async () => void row!.run());
    const dialog = await screen.findByRole("dialog", { name: "Make a Microsoft form" });
    expect(await within(dialog).findByText("RecWell, Esports")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Make" }));
    await waitFor(() => expect(wire.opened).toHaveLength(1));
    expect(wire.asked.filter((a) => a.method === "work.msforms.make")).toEqual([
      {
        env: "box",
        method: "work.msforms.make",
        params: {
          workspaceId: "ws-purdue",
          folder: { at: "file", host: "box", path: "/Users/l/purdue.edu/Esports" },
          title: "Tryouts",
          questions: [
            { title: "Name", type: "text", required: true },
            { title: "Night", type: "choice", dropdown: true, options: ["Mon", "Tue"], required: false },
          ],
        },
      },
    ]);
    expect(wire.opened[0]).toEqual(["box", "ws-purdue", { ref: { at: "msform", host: "box", workspaceId: "ws-purdue", formId: "Ob0wQVN8nEGx5YdY1tY_IQaWFXVrVqJAiq2zrvrF0001", tenant: "purdue0" }, name: "Tryouts" }]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says a refusal in the dialog and keeps it open; with no place there is nothing to press", async () => {
    wire.places = [place("recwell", "Esports", "RecWell")];
    wire.refuse = "Microsoft forms are made in a Teams or OneDrive folder this computer reaches.";
    render(<Seat />);
    await settle();
    await act(async () => void row!.run());
    const dialog = await screen.findByRole("dialog", { name: "Make a Microsoft form" });
    await within(dialog).findByText("RecWell, Esports");
    fireEvent.click(within(dialog).getByRole("button", { name: "Make" }));
    expect(await within(dialog).findByText(/Teams or OneDrive folder this computer reaches/)).toBeTruthy();
    expect(wire.opened).toEqual([]);
    cleanup();
    wire.places = [];
    render(<Seat />);
    await settle();
    await act(async () => void row!.run());
    const empty = await screen.findByRole("dialog", { name: "Make a Microsoft form" });
    expect(await within(empty).findByText("No Teams or OneDrive folder is on this computer.")).toBeTruthy();
    expect((within(empty).getByRole("button", { name: "Make" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
