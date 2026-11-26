// Fixtures for `bun run ui:preview src/renderer/src/chrome/Composer.preview.tsx#DockedComposerPreview`:
// the docked footer at rest, with a turn running, paused with the queue, with
// attachments in the box, and with three lines in the field.
// bun run ui:preview src/renderer/src/chrome/Composer.preview.tsx#ComposerMenus
// ComposerMenus draws the open controls. Live timing and focus are covered by DOM tests.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { previewClick, waitForPreview, previewCwd, previewNoop, previewNow, previewProject } from "../lib/previewHost.preview";
import { saveMidTurnDefault } from "../lib/settings";
const file = (id: string, name: string, kind: "image" | "file", mimeType: string, size: number) => ({
  id,
  name,
  kind,
  mimeType,
  size,
  path: `${previewCwd}/${name}`,
});

const thumbnail = "data:image/png;base64," + readFileSync(join(import.meta.dirname, "../../public/mark.png")).toString("base64");
const image = { ...file("preview-image", "notes-list.png", "image", "image/png", 48_000), previewUrl: thumbnail };
const pasted = { id: "preview-paste", name: "Pasted image.png", kind: "image", mimeType: "image/png", size: 920, previewUrl: thumbnail, data: thumbnail.slice(thumbnail.indexOf(",") + 1) };
const files = [file("copy", "notes.csv", "file", "text/csv", 20_000), file("failed", "archive.zip", "file", "application/zip", 182_000), image, pasted];

export const DockedComposerPreviewFixtures = [
  { name: "Docked, a thread with a message", props: { id: "preview-docked" } },
  { name: "Docked, a turn running 1m 32s", props: { id: "preview-running", status: "running", elapsedMs: 92_000 } },
  {
    name: "Docked, paused with two queued",
    props: {
      id: "preview-queue",
      status: "paused",
      elapsedMs: 252_000,
      queue: [
        { id: "q1", text: "Then run the tests you touched", ts: 1 },
        { id: "q2", text: "And keep the remembered draft when a pane closes, so the person never loses what they typed", ts: 2, provider: "codex", model: "gpt-6.1-sol", reasoning: "high" },
      ],
    },
  },
  {
    name: "Docked, two attachments",
    props: {
      id: "preview-attachments",
      draft: "What do these two show?",
      attachments: [file("a1", "login-error.png", "image", "image/png", 182_000), file("a2", "gateway.log", "file", "text/plain", 48_000)],
    },
  },
  {
    name: "Docked, three lines",
    props: {
      id: "preview-three-lines",
      draft: "Rework the login flow so a lapsed token asks once\nKeep the remembered draft\nThen run the tests you touched",
    },
  },
  { name: "Host offline", props: { id: "preview-offline", degraded: "offline" } },
  { name: "Host reconnecting", props: { id: "preview-reconnect", degraded: "reconnecting" } },
  { name: "Key refused", props: { id: "preview-refused", degraded: "unauthorized" } },
  { name: "Remote key with read access", props: { id: "preview-read-key", readKey: true, draft: "Try the cache again" } },
  {
    name: "No account on the host", props: { id: "preview-no-account", draft: "Check the notes cache" },
  },
  {
    name: "Failed send keeps the words",
    props: { id: "preview-send-failed", draft: "Keep my draft if this chat closes", composerProps: { onSubmit: () => false } },
    prepare: (root: HTMLElement) => previewClick(root, '[data-intent="send"]'),
  },
  {
    name: "Uploading, failed, image and pasted image",
    props: {
      id: "preview-upload", draft: "What changed in this export?", attachments: files,
      composerProps: { initialAttachmentStatus: { uploads: { copy: { sent: 8_000, total: 20_000 }, failed: { sent: 0, total: 182_000, failed: true } }, note: "Could not copy the archive to this host" } },
    },
  },
  {
    name: "Drag files over the box",
    props: { id: "preview-file-drag" },
    prepare: (root: HTMLElement) => {
      const event = new window.Event("dragover", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"] } });
      root.querySelector("[data-session-drop]")!.dispatchEvent(event);
      const wash = () => root.querySelector<HTMLElement>("[data-composer-box] .pointer-events-none.absolute.inset-0");
      return new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
        wash()?.style.removeProperty("opacity");
        resolve();
      })));
    },
  },
  {
    name: "Steer a running turn",
    props: { id: "preview-steer", status: "running", draft: "Skip the export for now", elapsedMs: 72_000 },
    prepare: () => { saveMidTurnDefault("steer"); },
  },
  {
    name: "Queued until the wait finishes",
    props: { id: "preview-wait-queue", status: "running", waiting: true, queue: [{ id: "q", text: "Summarize what the checks found", ts: 4 }] },
  },
  {
    name: "Draft in a project with a branch",
    props: { id: "preview-project", draftThread: true, composerProps: { branch: "main", projectId: previewProject.id, recents: [{ path: previewCwd, openedAt: 1 }], onBranchChange: previewNoop } },
  },
  {
    name: "Draft with a host that can make a new copy",
    props: { id: "preview-new-copy", draftThread: true, composerProps: { branch: "main", projectId: previewProject.id } },
    prepare: async (root: HTMLElement) => {
      previewClick(root, "[data-draft-host-picker]");
      await waitForPreview(() => [...document.querySelectorAll("[data-draft-host-note]")].find((node) => node.textContent === "New copy"));
    },
  },
  {
    name: "Draft with branch lookup pending",
    props: { id: "preview-branch-loading", draftThread: true, composerProps: { cwd: "/projects/field-notes-next", executionCwd: "/projects/field-notes-next" } },
  },
].map((fixture) => ({ ...fixture, now: previewNow }));

export const ComposerMenusFixtures = [
  { name: "Add menu", props: { menu: "add" }, prepare: (root: HTMLElement) => previewClick(root, 'button[aria-label="Add"]') },
  { name: "Permission select", props: { menu: "access" } },
  { name: "Thread type select", props: { menu: "type" } },
];
