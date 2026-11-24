import { RevealTargetSchema, type RevealNavigation, type RevealTarget } from "@shared/contract-work-reveal";
import type { OpenWorkView } from "./workSwitch";

const VIEW_AT: Partial<Record<NonNullable<RevealTarget["view"]>, "event" | "mail" | "task" | "project" | "person" | "chat">> = {
  agenda: "event",
  prep: "event",
  mail: "mail",
  tasks: "task",
  projects: "project",
  people: "person",
  messages: "chat",
};

interface RevealOpeners {
  thread(id: string): Promise<void>;
  workspace(workspace: NonNullable<RevealNavigation["workspace"]>): void;
  view(view: OpenWorkView): void;
  place(id: string, at?: number): void;
  files(workspace: NonNullable<RevealNavigation["workspace"]>, item: Exclude<NonNullable<RevealNavigation["item"]>, { owner: string }>): Promise<void>;
  threadItem(owner: string, id: string): Promise<void>;
  held(key: string): Promise<void>;
  settings(name: NonNullable<RevealTarget["settings"]>): void;
}

/** Dispatches the checked target to the window's navigation openers. */
export async function openReveal(nav: RevealNavigation, open: RevealOpeners): Promise<boolean> {
  const parsed = RevealTargetSchema.safeParse(nav.target);
  if (!parsed.success) return false;
  const { held, thread, view, workspaceId, place, item, settings, at } = parsed.data;
  if (held) await open.held(`local:${held.at}:${held.id}`);
  else if (thread) await open.thread(thread);
  else if (place) open.place(place, at === undefined ? undefined : Number(at));
  else if (settings) open.settings(settings);
  else if (view && nav.workspace && workspaceId === nav.workspace.id) {
    open.workspace(nav.workspace);
    const where: OpenWorkView = { workspaceId, view };
    const field = VIEW_AT[view];
    if (field && at) where[field] = at;
    open.view(where);
  } else if (item && nav.item) {
    if ("owner" in nav.item) await open.threadItem(nav.item.owner, item);
    else {
      if (!nav.workspace) return false;
      open.workspace(nav.workspace);
      await open.files(nav.workspace, nav.item);
    }
  } else return false;
  return true;
}

export async function revealInWindow(nav: RevealNavigation, openThread: RevealOpeners["thread"]): Promise<void> {
  const [{ openWorkView }, { shell }, { openWorkPlaceAt }, { project }, { normalizeProjectPath }] = await Promise.all([
    import("./workSwitch"),
    import("../stores/shell"),
    import("./workPlaceAt"),
    import("../stores/project"),
    import("./recents"),
  ]);
  await openReveal(nav, {
    thread: openThread,
    workspace: (workspace) => {
      shell.closeOverlays();
      project.setProjectCwd(normalizeProjectPath(workspace.path));
    },
    view: openWorkView,
    place: openWorkPlaceAt,
    async files(workspace, item) {
      const { openInFiles } = await import("../work/files/openFrom");
      await openInFiles({ id: workspace.id, environmentId: "local" }, item);
    },
    async threadItem(owner, id) {
      const { openItem, setFolded } = await import("../work/canvas/store");
      await openItem("local", owner, { itemId: id });
      setFolded(owner, true);
      await openThread(owner);
    },
    async held(key) {
      const { wantOutboxItem } = await import("../work/outbox/store");
      wantOutboxItem(key);
      shell.openOutbox();
    },
    settings: (name) => shell.openSettings(name),
  });
}
