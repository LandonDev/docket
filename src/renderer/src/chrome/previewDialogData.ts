// Workspace and project data for the static dialogs.
import { asGivenComputer } from "../work/kit.preview";
import { registry } from "../lib/connection/registry";
import { workspaceStore } from "../lib/tcserver/workspaces";
import type { ProjectMeta, WorkspaceMeta } from "../lib/tcserver/types";

export const guideWorkspace: WorkspaceMeta = {
  id: "guide", environmentId: "local", name: "Field guide", path: "/projects/field-guide", git: true, kind: "code", createdAt: 1,
  preamble: "## Before publishing\n\nCheck the bridge notice and read the route notes aloud.", preambleEnabled: true,
};
export const guideProject = {
  id: "guide-spring", environmentId: "local", workspaceId: guideWorkspace.id, name: "Spring edition",
  mode: "worktree", branch: "spring-edition", archived: false, cwd: "/projects/spring-edition", createdAt: 1,
  preamble: "## Spring edition\n\nUse the latest trail map.", preambleEnabled: true,
} satisfies ProjectMeta;

export const ignorePreviewAction = () => {};
export const previewPending = new Promise<never>(() => {});

export function enterPreviewText(selector: string, text: string): void {
  const field = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
  if (!field) return;
  const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(field, text);
  field.dispatchEvent(new window.Event("input", { bubbles: true }));
}

export function clickPreviewButton(name: string): void {
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
    button.getAttribute("aria-label") === name || button.textContent?.trim() === name,
  )?.click();
}

const guideLink = "field-guide-link";
export const linkedGuideProject = { ...guideProject, linkId: guideLink };
export const guideMacWorkspace = { ...guideWorkspace, id: "guide-mac", environmentId: "mac" };
export const guideMacProject = { ...linkedGuideProject, id: "guide-remote", workspaceId: guideMacWorkspace.id, environmentId: "mac" };

export function seedGuideCatalog({ offline, readOnly = false }: { offline?: "local" | "mac"; readOnly?: boolean } = {}) {
  asGivenComputer({
    on: readOnly ? ["local"] : [],
    caps: ["read"],
    computers: [{ id: "local", name: "The box", platform: "linux" }, { id: "mac", name: "This Mac", platform: "darwin" }],
  });
  for (const [id, status] of registry.statuses()) {
    if (status.lastHello) {
      status.lastHello.environmentId = id;
      status.lastHello.build = { platform: id === "mac" ? "darwin" : "linux", headless: id === "local" } as NonNullable<typeof status.lastHello.build>;
    }
    if (id === offline) status.transport = "offline";
  }
  workspaceStore.hydrate([
    { environmentId: "local", workspaces: [guideWorkspace], projects: [linkedGuideProject] },
    { environmentId: "mac", workspaces: [guideMacWorkspace], projects: [guideMacProject] },
  ]);
}
