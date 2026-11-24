// @vitest-environment jsdom
/**
 * Save as Word to… (docs/agents/work-files.md "Save as Word to a folder"): a document's Files tab has the row in its ⋯
 * menu, a text file's does not; the row opens the Move to… dialog on his places, a press walks into one, and Save Here
 * asks the workspace's host to write the document as Word there, said in one toast with Show, which opens that folder.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileTab } from "@shared/contract-work-files";
import type { CanvasItem } from "@shared/work";
import type { FilePlace } from "@shared/work/files";
import type { WorkspaceMeta } from "../../lib/tcserver/types";

const world = vi.hoisted(() => ({ calls: [] as { method: string; params: Record<string, unknown> }[], toasts: [] as { title: string; show?: () => void }[], opened: [] as unknown[] }));

const at = (path: string) => ({ at: "file" as const, host: "env_box", path });
const place = (id: string, kind: string, name: string, root: string, can: string[] = ["make"]): FilePlace => ({ id, kind, name, host: "The box", env: "env_box", shared: kind !== "folder", can, state: { state: "ok" }, root: at(root) }) as unknown as FilePlace;

vi.mock("../../lib/connection", async (original) => {
  const linkOf = (id: string) => ({
    environmentId: id,
    connected: true,
    request: async (method: string, params: Record<string, unknown> = {}) => {
      world.calls.push({ method, params });
      if (method === "work.files.places")
        return { places: [place("folder", "folder", "Dummy Esports", "/w"), { ...place("b1", "teams", "General", "/cloud/General"), group: "Esports Staff", key: "general" }], sources: [] };
      if (method === "work.files.list") return { entries: [], trail: [{ name: "General", at: at("/cloud/General") }] };
      if (method === "work.files.saveAsWord") return { name: "Run of show.docx", ref: at("/cloud/General/Run of show.docx") };
      if (method === "work.office.filesCopyGet") return { on: false };
      throw new Error(`unexpected ${method}`);
    },
    onPush: () => () => undefined,
    onOpen: () => () => undefined,
    onClose: () => () => undefined,
  });
  return { ...(await original<typeof import("../../lib/connection")>()), registry: { linkOf, link: linkOf, has: () => true, environment: () => ({ name: "The box" }), environments: () => [], onLink: () => () => undefined, statusOf: () => ({ transport: "open" }) } };
});
vi.mock("../shell/actions", () => ({ workspaceSettings: async () => ({ mayUseDesktop: [], windowsVm: false }), localHostId: async () => null, windowDesktops: async () => [], linkIdOfHost: () => "box" }));
vi.mock("../canvas/CanvasPane", () => ({ CanvasPane: () => <div data-testid="pane" /> }));
vi.mock("../../components/ui/toaster", async (original) => ({
  ...(await original<typeof import("../../components/ui/toaster")>()),
  loadToast: async () => ({
    message: (title: string, o: { action?: { onClick(): void } } = {}) => void world.toasts.push({ title, ...(o.action ? { show: o.action.onClick } : {}) }),
    error: (title: string) => void world.toasts.push({ title }),
  }),
}));
const META = { id: "w1", environmentId: "box", path: "/w", name: "Dummy Esports", kind: "work" } as WorkspaceMeta;
vi.mock("./workspaceOf", () => ({ useWorkspaceOf: () => META }));
vi.mock("./openFrom", () => ({ openInFiles: async (_w: unknown, what: unknown) => void world.opened.push(what) }));

const { FileTabView } = await import("./FileTabView");

const item = (kind: CanvasItem["kind"], path: string, title: string): CanvasItem =>
  ({ id: "i1", sessionId: "filespane_w1", workspaceId: "w1", kind, title, source: { at: "file", host: "env_box", path }, state: "open", position: 0, rev: 0, createdAt: 1, updatedAt: 1 }) as CanvasItem;
const tab = (name: string): FileTab => ({ id: "t1", kind: "file", name, itemId: "i1", key: name });
const show = (kind: CanvasItem["kind"], name: string, title: string) =>
  render(<FileTabView tab={tab(name)} item={item(kind, `/w/${name}`, title)} panelId="p" workspace={META} where="Dummy Esports" copy={null} onClose={() => undefined} />);
const openMenu = async (name: string): Promise<HTMLElement> => {
  fireEvent.click(within(document.querySelector("[data-files-header]") as HTMLElement).getByRole("button", { name: `More for ${name}` }));
  return screen.findByRole("menu");
};

beforeEach(() => {
  world.calls.length = 0;
  world.toasts.length = 0;
  world.opened.length = 0;
});
afterEach(cleanup);

describe("Save as Word to…", () => {
  it("is a row of a document's ⋯ menu and of no text file's", async () => {
    show("file", "Notes.md", "Notes.md");
    expect(within(await openMenu("Notes.md")).queryByRole("menuitem", { name: "Save as Word to…" })).toBeNull();
    cleanup();
    show("document", "Run of show.tcdoc", "Run of show");
    expect(within(await openMenu("Run of show.tcdoc")).getByRole("menuitem", { name: "Save as Word to…" })).toBeTruthy();
  });

  it("picks a folder of his places, saves the document there as Word, and says where with Show", async () => {
    show("document", "Run of show.tcdoc", "Run of show");
    fireEvent.click(within(await openMenu("Run of show.tcdoc")).getByRole("menuitem", { name: "Save as Word to…" }));
    const dialog = await screen.findByRole("dialog", { name: "Save Run of show as Word" });
    // It opens on the places: the workspace's folder and each library, a team's named with a comma.
    await waitFor(() => expect(within(dialog).getAllByRole("option").map((o) => o.textContent)).toEqual(["Dummy Esports", "Esports Staff, General"]));
    fireEvent.click(within(dialog).getByRole("option", { name: "Esports Staff, General" }));
    const save = await within(dialog).findByRole("button", { name: "Save Here" });
    await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(save);
    await waitFor(() => expect(world.toasts).toHaveLength(1));
    expect(world.calls.find((c) => c.method === "work.files.saveAsWord")?.params).toMatchObject({ workspaceId: "w1", source: { at: "file", host: "env_box", path: "/w/Run of show.tcdoc" }, at: at("/cloud/General") });
    // A place of a team is named as its row: the team, then the channel.
    expect(world.toasts[0]!.title).toBe("Saved as Word in Esports Staff, General");
    world.toasts[0]!.show!();
    expect(world.opened).toEqual([{ page: { at: at("/cloud/General"), name: "Esports Staff, General" } }]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("offers no Save until a folder is picked", async () => {
    show("document", "Run of show.tcdoc", "Run of show");
    fireEvent.click(within(await openMenu("Run of show.tcdoc")).getByRole("menuitem", { name: "Save as Word to…" }));
    const dialog = await screen.findByRole("dialog", { name: "Save Run of show as Word" });
    expect((within(dialog).getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
