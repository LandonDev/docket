// @vitest-environment jsdom
/**
 * The composer of a Work draft and a Work thread (docs/DESIGN.md "A Work draft"): no type picker, Master thread, name
 * field or context meter; the draft's filing control at the left moves the unsent draft between projects and jobs
 * keeping its words, files and chips; one settings glyph at the right holds Chat or Research, the model among Work's
 * providers and access in Work's words. A code composer keeps its own row.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextChip } from "@shared/work";

const picker = vi.hoisted(() => ({ props: null as null | { providers?: readonly string[] } }));
vi.mock("../../chrome/ModelPicker", () => ({
  ModelPicker: (props: { providers?: readonly string[] }) => {
    picker.props = props;
    return <button type="button" data-testid="model-picker" data-providers={props.providers?.join(",") ?? "all"} />;
  },
}));
vi.mock("../../chrome/ContextMeter", () => ({ ContextMeter: () => <span data-testid="context-meter" /> }));
vi.mock("../../chrome/ThreadTypeChip", () => ({ ThreadTypeChip: () => <span data-testid="type-chip" /> }));
vi.mock("../../chrome/MasterCheck", () => ({ MasterCheck: () => <span data-testid="master" /> }));
vi.mock("../../chrome/DraftTitleField", () => ({ DraftTitleField: () => <span data-testid="name-field" /> }));
vi.mock("../../chrome/DraftHostPicker", () => ({ DraftHostPicker: () => <span data-testid="host-picker" /> }));
vi.mock("../../chrome/CwdPicker", () => ({ CwdPicker: () => null }));
vi.mock("../../chrome/BranchPicker", () => ({ BranchPicker: () => null }));
vi.mock("../../chrome/AccessPicker", () => ({ AccessPicker: () => <span data-testid="code-access" /> }));
const opened = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("../shell/actions", () => ({
  openLifeosProject: async (workspace: { id: string; environmentId: string }, lifeosProjectId: string) => {
    opened.calls.push(lifeosProjectId);
    return { id: `mirror-${lifeosProjectId}`, workspaceId: workspace.id, environmentId: workspace.environmentId };
  },
}));

import { Composer } from "../../chrome/Composer";
import { draftKeyOf, filedDraft, movedDraftKey, projectDrafts, type DraftPlace } from "../../lib/projectDrafts";
import { newSession, type Session } from "../../lib/session";
import { sessionStore } from "../../lib/tcserver/store";
import { workspaceStore } from "../../lib/tcserver/workspaces";
import { setLifeosProjects } from "../../lib/workSwitch";
import { workComposerChunk } from "../../surfaces/chunks";
import { addContextChip, contextChipsOf, resetContextChips } from "../canvas/chips";

const purdue = { id: "w-purdue", name: "Purdue Esports", path: "/jobs/purdue", kind: "work", sector: "purdue" };
const cosmic = { id: "w-cosmic", name: "Cosmic", path: "/jobs/cosmic", kind: "work", sector: "cosmic" };
const code = { id: "w-code", name: "temp-code", path: "/src/temp-code", kind: "code" };
const lan = { id: "p-lan", workspaceId: "w-purdue", name: "Spring LAN", mode: "local", branch: null, cwd: "/jobs/purdue", archived: false, createdAt: 1, lifeosProjectId: "lp-lan" };
const task: ContextChip = { kind: "task", label: "Count the patch cables", ref: { at: "lifeos", table: "tasks", id: "t1" } };

const noop = () => {};
function seedDraft(id: string, over: Partial<Session> = {}): Session {
  const session: Session = { ...newSession("local", "claude", "/jobs/purdue", "claude-opus-5-5"), id, workspaceId: "w-purdue", projectId: "p-lan", threadType: "chat", ...over };
  sessionStore.mutate((prev) => [...prev.filter((s) => s.id !== id), session]);
  return session;
}

function mount(id: string, over: Partial<ComponentProps<typeof Composer>> = {}) {
  const session = sessionStore.get(id)!;
  return render(
    <Composer
      focused={false}
      harness="claude"
      model="claude-opus-5-5"
      runtimeMode="supervised"
      cwd="/jobs/purdue"
      executionCwd="/jobs/purdue"
      sessionId={id}
      work
      threadType={session.threadType ?? "chat"}
      onThreadTypeChange={noop}
      master={false}
      onMasterChange={noop}
      draftTitle=""
      onDraftTitleChange={noop}
      onFocus={noop}
      onCwdChange={noop}
      onModelChange={noop}
      onRuntimeModeChange={noop}
      onSubmit={noop}
      onDraftFile={noop}
      {...over}
    />,
  );
}

/** App's `onDraftFile`, the part a test can run: the record takes the new key, the session its new place. */
function fileAsApp(id: string) {
  return (to: DraftPlace) => {
    const from = projectDrafts.keyOfDraft(id)!;
    projectDrafts.move(from, movedDraftKey({ fromKey: from, toScope: draftKeyOf(to, workspaceStore.getSnapshot()), id, record: (k) => projectDrafts.get(k), sent: () => false }));
    sessionStore.mutate((prev) => prev.map((s) => (s.id === id ? filedDraft(s, to) : s)));
  };
}

const field = (view: ReturnType<typeof render>) => view.container.querySelector<HTMLElement>("[data-composer-input]")!;
const filing = () => screen.findByRole("button", { name: /^Files in/ });

beforeEach(async () => {
  localStorage.clear();
  projectDrafts.reload();
  resetContextChips();
  opened.calls = [];
  workspaceStore.hydrate([{ environmentId: "local", workspaces: [purdue, cosmic, code], projects: [lan] }]);
  setLifeosProjects("w-purdue", [
    { id: "lp-lan", name: "Spring LAN" },
    { id: "lp-budget", name: "FY27 budget" },
  ]);
  await workComposerChunk.load();
});
afterEach(cleanup);

describe("a Work draft's composer", () => {
  it("asks what it should do, and holds no type picker, Master thread, name field, host picker or context meter", async () => {
    seedDraft("d1");
    const view = mount("d1", { context: { used: 84_000, window: 200_000 } });
    expect(field(view).outerHTML).toContain("What should it do?");
    expect(view.container.outerHTML).not.toContain("How can I help you today?");
    await filing();
    for (const id of ["type-chip", "master", "name-field", "host-picker", "context-meter", "code-access"]) expect(screen.queryByTestId(id)).toBeNull();
    expect(screen.getByRole("button", { name: "Thread settings" })).toBeTruthy();
  });

  it("names where it files: the job, then the project", async () => {
    seedDraft("d1");
    mount("d1");
    const trigger = await filing();
    expect(trigger.textContent).toBe("Purdue EsportsSpring LAN");
    expect(trigger.getAttribute("aria-label")).toBe("Files in Purdue Esports, Spring LAN");
  });

  it("lists the job's projects as the column does, No project and Another job", async () => {
    seedDraft("d1");
    mount("d1");
    await act(async () => fireEvent.click(await filing()));
    const menu = await screen.findByRole("menu", { name: "Where it files" });
    const rows = within(menu).getAllByRole("menuitem").map((row) => row.textContent);
    expect(rows).toEqual(["Spring LAN", "FY27 budget", "No project", "Another job"]);
    expect(within(menu).getByRole("menuitem", { name: "Spring LAN" }).dataset.checked).toBe("true");
  });

  it("moves the unsent draft to No project keeping its words, its files and its chips", async () => {
    seedDraft("d1");
    projectDrafts.put("p-lan", {
      id: "d1",
      environmentId: "local",
      projectId: "p-lan",
      workspaceId: "w-purdue",
      cwd: "/jobs/purdue",
      harness: "claude",
      model: "claude-opus-5-5",
      modelSettings: {},
      runtimeMode: "supervised",
      threadType: "chat",
      threadRules: null,
      segments: [{ text: "Ask Sam for two switches" }],
      attachments: [{ id: "a1", name: "seat-map.xlsx", mimeType: "application/vnd.ms-excel", kind: "file", size: 9_000, path: "/jobs/purdue/seat-map.xlsx" }],
    });
    addContextChip("d1", task);
    const view = mount("d1", { onDraftFile: fileAsApp("d1") });
    expect(field(view).textContent).toBe("Ask Sam for two switches");
    await act(async () => fireEvent.click(await filing()));
    await act(async () => fireEvent.click(await screen.findByRole("menuitem", { name: "No project" })));

    expect(sessionStore.get("d1")).toMatchObject({ projectId: null, workspaceId: "w-purdue" });
    expect(projectDrafts.keyOfDraft("d1")).toBe("loose:w-purdue");
    expect(projectDrafts.get("loose:w-purdue")?.segments).toEqual([{ text: "Ask Sam for two switches" }]);
    expect(contextChipsOf("d1")).toEqual([task]);
    await waitFor(async () => expect((await filing()).textContent).toBe("Purdue Esports"));

    // The composer that mounts next (a switch, a relaunch's rebuild) finds all of it.
    cleanup();
    const again = mount("d1");
    expect(field(again).textContent).toBe("Ask Sam for two switches");
    expect(again.getByText("seat-map.xlsx")).toBeTruthy();
    await waitFor(() => expect(again.container.querySelector("[data-composer-chips]")).not.toBeNull());
  });

  it("opens a LifeOS project's mirror first when it has none, as the column does, then files there", async () => {
    seedDraft("d1");
    const onDraftFile = vi.fn();
    mount("d1", { onDraftFile });
    await act(async () => fireEvent.click(await filing()));
    await act(async () => fireEvent.click(await screen.findByRole("menuitem", { name: "FY27 budget" })));
    await waitFor(() => expect(onDraftFile).toHaveBeenCalledWith({ environmentId: "local", projectId: "mirror-lp-budget", workspaceId: "w-purdue", cwd: "/jobs/purdue" }));
    expect(opened.calls).toEqual(["lp-budget"]);
  });

  it("files in another job, loose there", async () => {
    seedDraft("d1");
    const onDraftFile = vi.fn();
    mount("d1", { onDraftFile });
    await act(async () => fireEvent.click(await filing()));
    await act(async () => fireEvent.click(await screen.findByRole("menuitem", { name: "Another job" })));
    await act(async () => fireEvent.click(await screen.findByRole("menuitem", { name: "Cosmic" })));
    expect(onDraftFile).toHaveBeenCalledWith({ environmentId: "local", projectId: null, workspaceId: "w-cosmic", cwd: "/jobs/cosmic" });
  });

  it("holds Chat or Research, the model among Work's providers, and access in Work's words behind one glyph", async () => {
    seedDraft("d1");
    const onThreadTypeChange = vi.fn();
    const onRuntimeModeChange = vi.fn();
    mount("d1", { onThreadTypeChange, onRuntimeModeChange });
    await act(async () => fireEvent.click(await screen.findByRole("button", { name: "Thread settings" })));
    const pop = await screen.findByRole("dialog", { name: "Thread settings" });
    const types = within(pop).getByRole("group", { name: "Thread type" });
    expect(within(types).getAllByRole("button").map((b) => b.textContent)).toEqual(["Chat", "Research"]);
    await act(async () => fireEvent.click(within(types).getByRole("button", { name: "Research" })));
    expect(onThreadTypeChange).toHaveBeenCalledWith("research");
    expect(within(pop).getByTestId("model-picker").dataset.providers).toBe("claude,codex,muse");
    const access = within(pop).getByRole("combobox", { name: "Access: Asks first" });
    await act(async () => fireEvent.click(access));
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      "Asks firstAsks before it changes a file or runs a program.",
      "Edits on its ownChanges files on its own, asks before it runs a program.",
      "Works on its ownChanges files and runs programs without asking.",
    ]);
    expect(screen.getByText("Sending, posting and sharing always wait for your press.")).toBeTruthy();
    const full = options[2]!;
    await act(async () => {
      fireEvent.pointerDown(full, { pointerType: "mouse" });
      fireEvent.mouseDown(full);
      fireEvent.pointerUp(full, { pointerType: "mouse" });
      fireEvent.mouseUp(full);
      fireEvent.click(full);
    });
    expect(onRuntimeModeChange).toHaveBeenCalledWith("full-access");
  });

  it("the + menu offers to mention a task, mail, file or thread", async () => {
    seedDraft("d1");
    mount("d1");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add" })));
    expect(await screen.findByRole("menuitem", { name: "Mention a task, mail, file or thread" })).toBeTruthy();
  });
});

describe("a Work thread's composer", () => {
  it("asks for a reply or a steer, files nowhere, and keeps the one glyph with no thread type", async () => {
    seedDraft("t1", { blocks: [{ id: "u1", role: "user", text: "Ask ITaP for two switches" } as Session["blocks"][number]] });
    const view = mount("t1", { context: { used: 84_000, window: 200_000 } });
    expect(field(view).outerHTML).toContain("Reply, or steer the work");
    await act(async () => fireEvent.click(await screen.findByRole("button", { name: "Thread settings" })));
    const pop = await screen.findByRole("dialog", { name: "Thread settings" });
    expect(within(pop).queryByRole("group", { name: "Thread type" })).toBeNull();
    expect(within(pop).getByTestId("model-picker")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Files in/ })).toBeNull();
    expect(screen.queryByTestId("context-meter")).toBeNull();
  });
});

describe("a code composer", () => {
  it("keeps its model, context meter, access and draft row, its own words and every provider", async () => {
    seedDraft("c1", { workspaceId: "w-code", projectId: null, blocks: [{ id: "u1", role: "user", text: "Rework the login flow" } as Session["blocks"][number]] });
    const view = mount("c1", { work: false, cwd: "/src/temp-code", executionCwd: "/src/temp-code", context: { used: 84_000, window: 200_000 } });
    expect(field(view).outerHTML).toContain("Ask, build, / for skills, @ for references…");
    expect(screen.getByTestId("context-meter")).toBeTruthy();
    expect(screen.getByTestId("code-access")).toBeTruthy();
    expect(screen.getByTestId("model-picker").dataset.providers).toBe("all");
    expect(screen.queryByRole("button", { name: "Thread settings" })).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add" })));
    expect(await screen.findByRole("menuitem", { name: "Mention a file or thread" })).toBeTruthy();
  });
});
