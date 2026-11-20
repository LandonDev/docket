// @vitest-environment jsdom
/**
 * A Work project's settings sheet: nothing of code in it; Name and State
 * written to LifeOS on the workspace's own session; read-only, with the
 * reason said once, while LifeOS cannot be reached; rules edited in their
 * own dialog with no worktree word; Delete asked first.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";
import type { ConvexReactClient } from "convex/react";
import { registry } from "../../lib/connection";
import type { ProjectMeta, WorkspaceMeta } from "../../lib/tcserver/types";
import { workspaceStore } from "../../lib/tcserver/workspaces";
import { workSwitch } from "../../lib/workSwitch";
import { PreambleDialog } from "../../chrome/PreambleDialog";
import { ProjectSettingsDialog } from "../../chrome/ProjectDialogs";
import { resetLifeos, setLifeosSession, setLifeosStatus } from "./lifeos";
import { rulesLine, WorkProjectFields } from "./ProjectSettings";

// jsdom has no Web Animations; the sheet's scroll area asks for them.
if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];

const BOX = "env_box";
const WORK: WorkspaceMeta = { id: "ws", name: "Purdue Esports", path: "/srv/work/Work/Purdue", git: false, kind: "work", sector: "purdue", createdAt: 1, environmentId: BOX } as WorkspaceMeta;
const CODE: WorkspaceMeta = { id: "wc", name: "temp-code", path: "/srv/work/temp-code", git: true, createdAt: 1, environmentId: BOX } as WorkspaceMeta;
const MIRROR: ProjectMeta = {
  id: "p1",
  workspaceId: "ws",
  name: "Spring LAN",
  mode: "local",
  branch: null,
  cwd: WORK.path,
  archived: false,
  createdAt: 1,
  environmentId: BOX,
  lifeosProjectId: "lp_1",
  preamble: "Write to the director as Landon. Keep it short.",
} as ProjectMeta;
const CODE_PROJECT: ProjectMeta = { id: "pc", workspaceId: "wc", name: "Alpha", mode: "worktree", branch: "alpha", cwd: "/srv/work/wt/alpha", archived: false, createdAt: 1, environmentId: BOX } as ProjectMeta;

type Sent = { fn: string; args: Record<string, unknown> };
let sent: Sent[] = [];
let failWrites: string | null = null;
let hostCalls: { method: string; params: Record<string, unknown> }[] = [];

/** What the live list tells its watchers when LifeOS's rows change. */
let listUpdates = new Set<() => void>();

/** A LifeOS session whose list holds the mirror's project, and whose writes are recorded. `rows` is read afresh on each update. */
function lifeosClient(rows = [{ _id: "lp_1", name: "Spring LAN", status: "active" }]): ConvexReactClient {
  return {
    watchQuery: () => ({
      localQueryResult: () => [...rows],
      onUpdate: (fn: () => void) => {
        listUpdates.add(fn);
        return () => void listUpdates.delete(fn);
      },
    }),
    mutation: async (ref: never, args: Record<string, unknown>) => {
      sent.push({ fn: getFunctionName(ref), args });
      if (failWrites) throw new Error(failWrites);
      return null;
    },
    close: async () => {},
  } as unknown as ConvexReactClient;
}

const connected = (client = lifeosClient()): void => {
  setLifeosStatus(BOX, { lifeos: { state: "connected", ownerId: "landon", since: 1 }, keys: [] });
  setLifeosSession({ environmentId: BOX, sector: "purdue", client, state: "connected" });
};

beforeEach(() => {
  listUpdates = new Set();
  sent = [];
  hostCalls = [];
  failWrites = null;
  workspaceStore.reset();
  workspaceStore.hydrate([{ environmentId: BOX, workspaces: [WORK, CODE], projects: [MIRROR, CODE_PROJECT] }]);
  vi.spyOn(registry, "linkOf").mockReturnValue({
    environmentId: BOX,
    connected: true,
    onOpen: () => () => {},
    onPush: () => () => {},
    request: async (method: string, params: Record<string, unknown> = {}) => {
      hostCalls.push({ method, params });
      if (method === "work.guests.forItem") return [];
      if (method === "work.guests.create") return { link: { id: "L1", name: params.name, role: "view", expiresAt: params.expiresAt }, url: "https://tempcode.landonhale.com/g/L1#k=secret" };
      return null;
    },
  } as never);
  vi.spyOn(workspaceStore, "refresh").mockResolvedValue();
});

afterEach(() => {
  cleanup();
  resetLifeos();
  workSwitch.reset();
  workspaceStore.reset();
  vi.restoreAllMocks();
});

const sheet = () => screen.findByRole("dialog", { name: "Project settings" });
const saveButton = () => screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
const headings = (root: HTMLElement) => [...root.querySelectorAll("h3")].map((h) => h.textContent);

describe("which sheet a project gets", () => {
  it("a Work project's sheet draws no code field", async () => {
    connected();
    render(<ProjectSettingsDialog project={MIRROR} workspace={WORK} onClose={() => {}} />);
    const root = await sheet();
    expect(root.getAttribute("data-side")).toBe("right");
    // Its rules, and who outside may see it: the project's guest links, read from the host.
    expect(headings(root)).toEqual(["Rules for its threads", "Sharing"]);
    expect(hostCalls.find((c) => c.method === "work.guests.forItem")?.params).toEqual({ source: { at: "lifeos", table: "projects", id: MIRROR.lifeosProjectId } });
    expect(await within(root).findByText("Only you can open this")).toBeTruthy();
    expect(within(root).getByRole("button", { name: "New guest link…" })).toBeTruthy();
    // No mode, folder, branch, completed turn, review, plans or build.
    expect(root.querySelector("[data-project-mode]")).toBeNull();
    expect(root.textContent).not.toContain(WORK.path);
    expect(within(root).queryByLabelText("Branch")).toBeNull();
    for (const code of ["Completed turn", "Reviews", "Plans", "Build", "New threads"]) expect(headings(root)).not.toContain(code);
    // And it asked the host for none of them.
    expect(hostCalls.filter((c) => /^(build|plans|review|turnpass)\./.test(c.method))).toEqual([]);
  });

  it("a code project's sheet draws every code field", async () => {
    render(<ProjectSettingsDialog project={CODE_PROJECT} workspace={CODE} onClose={() => {}} />);
    const root = await sheet();
    expect(headings(root)).toEqual(["Completed turn", "Reviews", "Accounts", "Plans", "Build"]);
    expect(root.querySelector("[data-project-mode]")?.textContent).toBe("Worktree");
    expect(within(root).getByLabelText("Branch")).toBeTruthy();
    expect(root.querySelector("[data-work-project-settings]")).toBeNull();
  });
});

describe("Name and State", () => {
  const pick = async (name: string) => {
    await act(async () => {
      fireEvent.click(screen.getByRole("combobox", { name: "State" }));
    });
    const option = await screen.findByRole("option", { name });
    await act(async () => {
      fireEvent.pointerDown(option, { pointerType: "mouse" });
      fireEvent.click(option);
    });
  };

  it("are LifeOS's: Save writes projects:update on the workspace's session, and nothing to the host", async () => {
    connected();
    const onClose = vi.fn();
    render(<ProjectSettingsDialog project={MIRROR} workspace={WORK} onClose={onClose} />);
    await sheet();
    expect(saveButton().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "  Fall LAN " } });
    await pick("Paused");
    await act(async () => {
      fireEvent.click(saveButton());
    });
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ fn: "projects:update", args: { id: "lp_1", patch: { name: "Fall LAN", status: "paused" } } });
    expect(hostCalls.filter((c) => c.method.startsWith("project."))).toEqual([]);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("send only what changed", async () => {
    connected();
    render(<ProjectSettingsDialog project={MIRROR} workspace={WORK} onClose={() => {}} />);
    await sheet();
    await pick("Done");
    await act(async () => {
      fireEvent.click(saveButton());
    });
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].args).toEqual({ id: "lp_1", patch: { status: "done" } });
  });

  it("show LifeOS's name over the mirror's when they differ", async () => {
    connected(lifeosClient([{ _id: "lp_1", name: "Fall LAN", status: "backlog" }]));
    render(<ProjectSettingsDialog project={MIRROR} workspace={WORK} onClose={() => {}} />);
    await sheet();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Fall LAN");
    expect(screen.getByRole("combobox", { name: "State" }).textContent).toContain("Backlog");
  });

  it("a failed save says why, once, and Save is its retry: no second button does the same", async () => {
    connected();
    failWrites = "LifeOS refused the write";
    render(<ProjectSettingsDialog project={MIRROR} workspace={WORK} onClose={() => {}} />);
    const root = await sheet();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Fall LAN" } });
    await act(async () => {
      fireEvent.click(saveButton());
    });
    await waitFor(() => expect(screen.getByText("LifeOS refused the write")).toBeTruthy());
    const line = root.querySelector("[data-project-settings-error]")!;
    // One hairline between the error and the foot, the foot's own.
    expect(line.className).not.toContain("border-t");
    expect(line.nextElementSibling!.className).toContain("border-t");
    expect(within(line as HTMLElement).queryByRole("button")).toBeNull();
    expect(saveButton().hasAttribute("disabled")).toBe(false);
    failWrites = null;
    await act(async () => {
      fireEvent.click(saveButton());
    });
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1].args).toEqual({ id: "lp_1", patch: { name: "Fall LAN" } });
  });

  it("Save after a save that landed with its answer lost sends nothing more and closes the sheet", async () => {
    const rows = [{ _id: "lp_1", name: "Spring LAN", status: "active" }];
    connected(lifeosClient(rows));
    failWrites = "the connection dropped";
    const onClose = vi.fn();
    render(<ProjectSettingsDialog project={MIRROR} workspace={WORK} onClose={onClose} />);
    const root = await sheet();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Fall LAN" } });
    await act(async () => {
      fireEvent.click(saveButton());
    });
    await waitFor(() => expect(screen.getByText("the connection dropped")).toBeTruthy());
    // The write had landed: the live list now says so.
    rows[0] = { ...rows[0], name: "Fall LAN" };
    act(() => listUpdates.forEach((fn) => fn()));
    // Nothing differs now, yet Save stays live while the error stands: it is the retry, and finds the sheet done.
    expect(root.querySelector("[data-project-settings-error]")).not.toBeNull();
    await act(async () => {
      fireEvent.click(saveButton());
    });
    expect(sent).toHaveLength(1);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});

describe("while LifeOS cannot be reached", () => {
  it("signed out: the name stands as words, no state or Delete is drawn, nothing is disabled, and one line names the sign-in", async () => {
    setLifeosStatus(BOX, { lifeos: { state: "signed-out" }, keys: [] });
    render(<ProjectSettingsDialog project={MIRROR} workspace={WORK} onClose={() => {}} />);
    const root = await sheet();
    expect(root.querySelector("[data-readonly-name]")!.textContent).toBe("Spring LAN");
    expect(root.querySelector("input")).toBeNull();
    expect(screen.queryByRole("combobox", { name: "State" })).toBeNull();
    expect(root.querySelector("[data-readonly-state]")).toBeNull();
    expect(root.querySelectorAll("[data-lifeos-line]")).toHaveLength(1);
    // Asking again would not sign him in: the line has no Retry.
    expect(root.querySelector("[data-lifeos-line]")!.textContent).toBe("Sign in to LifeOS to change its name or state");
    expect(screen.queryByRole("button", { name: "Delete project" })).toBeNull();
    expect(saveButton().disabled).toBe(true);
    // The rules are this host's: they can still be edited.
    expect((screen.getByRole("button", { name: "Edit" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("unreachable: Retry asks the host for its LifeOS status again", async () => {
    setLifeosStatus(BOX, { lifeos: { state: "unreachable", since: 1, error: "timeout" }, keys: [] });
    render(<ProjectSettingsDialog project={MIRROR} workspace={WORK} onClose={() => {}} />);
    const root = await sheet();
    const line = root.querySelector("[data-lifeos-line]") as HTMLElement;
    expect(line.textContent).toContain("LifeOS did not answer");
    await act(async () => {
      fireEvent.click(within(line).getByRole("button", { name: "Retry" }));
    });
    expect(hostCalls.some((c) => c.method === "work.lifeos.status")).toBe(true);
  });

  it("a project LifeOS no longer has says so, with nothing to retry", async () => {
    connected(lifeosClient([]));
    render(<ProjectSettingsDialog project={MIRROR} workspace={WORK} onClose={() => {}} />);
    const root = await sheet();
    const line = root.querySelector("[data-lifeos-line]") as HTMLElement;
    expect(line.textContent).toBe("This project is no longer in LifeOS");
    expect(within(line).queryByRole("button")).toBeNull();
    expect(root.querySelector("[data-readonly-name]")!.textContent).toBe("Spring LAN");
    expect(screen.queryByRole("button", { name: "Delete project" })).toBeNull();
  });

  it("LifeOS dropping while he types keeps what he typed and holds Save, and the state it last told stands as a word", async () => {
    connected();
    render(<ProjectSettingsDialog project={MIRROR} workspace={WORK} onClose={() => {}} />);
    const root = await sheet();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Fall LAN" } });
    expect(saveButton().disabled).toBe(false);
    act(() => setLifeosStatus(BOX, { lifeos: { state: "unreachable", since: 1, error: "timeout" }, keys: [] }));
    await waitFor(() => expect(root.querySelector("[data-readonly-name]")).toBeTruthy());
    expect(root.querySelector("[data-readonly-name]")!.textContent).toBe("Fall LAN");
    expect(root.querySelector("[data-readonly-state]")!.textContent).toBe("Active");
    expect(saveButton().disabled).toBe(true);
    expect(sent).toEqual([]);
  });
});

describe("Rules for its threads", () => {
  it("says how much is sent, and Edit opens the rules dialog over the sheet with no worktree word", async () => {
    connected();
    render(<ProjectSettingsDialog project={MIRROR} workspace={WORK} onClose={() => {}} />);
    const root = await sheet();
    expect(root.querySelector("[data-rules-line]")!.textContent).toBe("9 words");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    });
    const rules = await screen.findByRole("dialog", { name: "Rules for new threads" });
    expect(within(rules).getByDisplayValue(MIRROR.preamble!)).toBeTruthy();
    const variables = rules.querySelector("[data-preamble-variables]")!.textContent;
    expect(variables).toContain("{{project}}");
    expect(variables).toContain("{{host}}");
    expect(variables).not.toContain("{{worktree}}");
    // Typing in it leaves the sheet open under it.
    fireEvent.change(within(rules).getByDisplayValue(MIRROR.preamble!), { target: { value: "Short." } });
    expect(document.querySelector("[data-work-project-settings]")).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(rules).getByRole("button", { name: "Save" }));
    });
    await waitFor(() => expect(hostCalls.find((c) => c.method === "project.setPreamble")?.params).toEqual({ projectId: "p1", preamble: "Short.", enabled: true }));
  });

  it("a code project's preamble keeps its name and its worktree word", async () => {
    render(<PreambleDialog scope={{ kind: "project", project: CODE_PROJECT, workspace: CODE }} onClose={() => {}} />);
    const preamble = await screen.findByRole("dialog", { name: "Preamble" });
    expect(preamble.querySelector("[data-preamble-variables]")!.textContent).toContain("{{worktree}}");
  });

  it("the row says how many words are sent, that none are, or that they are kept and not sent", () => {
    expect(rulesLine({ preamble: "", preambleEnabled: true })).toBe("None");
    expect(rulesLine({ preamble: "one", preambleEnabled: true })).toBe("1 word");
    expect(rulesLine({ preamble: "one two", preambleEnabled: false })).toBe("2 words, not sent");
  });
});

describe("Delete project", () => {
  it("asks first, then deletes the project in LifeOS and closes the sheet; the mirror is the host's to archive", async () => {
    connected();
    const onClose = vi.fn();
    render(<ProjectSettingsDialog project={MIRROR} workspace={WORK} onClose={onClose} />);
    await sheet();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete project" }));
    });
    const ask = await screen.findByRole("alertdialog");
    expect(ask.textContent).toContain("Delete Spring LAN?");
    expect(ask.textContent).toContain("Its tasks stay, with no project.");
    expect(sent).toEqual([]);
    await act(async () => {
      fireEvent.click(within(ask).getByRole("button", { name: "Delete project" }));
    });
    await waitFor(() => expect(sent).toEqual([{ fn: "projects:remove", args: { id: "lp_1" } }]));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(hostCalls.filter((c) => c.method === "project.delete" || c.method === "project.archive")).toEqual([]);
  });

  it("Cancel deletes nothing and leaves the sheet", async () => {
    connected();
    render(<ProjectSettingsDialog project={MIRROR} workspace={WORK} onClose={() => {}} />);
    await sheet();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete project" }));
    });
    const ask = await screen.findByRole("alertdialog");
    await act(async () => {
      fireEvent.click(within(ask).getByRole("button", { name: "Cancel" }));
    });
    expect(sent).toEqual([]);
    expect(document.querySelector("[data-work-project-settings]")).toBeTruthy();
  });
});

describe("Sharing", () => {
  it("makes a guest link from the sheet: the address shows once, the sheet stays open and nothing of the project is saved", async () => {
    const client = lifeosClient();
    connected(client);
    render(<ProjectSettingsDialog project={MIRROR} workspace={WORK} onClose={() => {}} />);
    const root = await sheet();
    // A change he has not saved: making a link must not save it for him.
    fireEvent.change(within(root).getByLabelText("Name"), { target: { value: "Fall LAN" } });
    fireEvent.click(await within(root).findByRole("button", { name: "New guest link…" }));
    fireEvent.change(await screen.findByPlaceholderText("Name"), { target: { value: "Dana Lee" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create link" }));
    });
    // The dialog's submit is the dialog's alone: it never reaches the sheet's form around it.
    expect(await screen.findByText("Link for Dana Lee")).toBeTruthy();
    expect(screen.getByText(/shown only now/)).toBeTruthy();
    expect(document.querySelector("[data-work-project-settings]")).toBeTruthy();
    expect(sent).toEqual([]);
    expect(hostCalls.find((c) => c.method === "work.guests.create")?.params).toMatchObject({ source: { at: "lifeos", table: "projects", id: MIRROR.lifeosProjectId }, name: "Dana Lee", role: "view" });
  });
});

describe("the fields alone", () => {
  it("hold the state's place with bones until LifeOS answers, the name already his to type in, and draw no account section with none to draw", () => {
    const { container } = render(<WorkProjectFields name="Spring LAN" onName={() => {}} state={null} onState={() => {}} reach={{ status: "loading" }} rules="None" onEditRules={() => {}} />);
    expect(container.querySelector("[data-state-loading]")).toBeTruthy();
    expect((screen.getByLabelText("Name") as HTMLInputElement).disabled).toBe(false);
    expect(container.querySelector("[disabled]")).toBeNull();
    expect(headings(container)).toEqual(["Rules for its threads"]);
  });

  it("a project that mirrors nothing has a name of its own and no state", () => {
    const { container } = render(<WorkProjectFields name="Notes" onName={() => {}} state={null} onState={() => {}} reach={{ status: "local" }} rules="None" onEditRules={() => {}} />);
    expect((screen.getByLabelText("Name") as HTMLInputElement).disabled).toBe(false);
    expect(container.textContent).not.toContain("State");
  });
});
