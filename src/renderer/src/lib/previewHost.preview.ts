// In-memory host for ui:preview. Runs the renderer's normal link and store
// code without a network connection or any app data.
import { bindServer } from "./native";
import { registry, type Hello } from "./connection";
import type { SocketLike } from "./connection/transport";
import type { SessionMeta } from "./tcserver/types";

export const previewNow = Date.UTC(2026, 10, 12, 16);
export const previewCwd = "/projects/field-notes";
export const previewNoop = () => {};
export const previewWorkspace = { id: "field-notes", name: "Field Notes", path: previewCwd, git: true, linkId: "wl_notes", createdAt: previewNow };
export const previewProject = { id: "notes-cache", name: "Notes cache", workspaceId: previewWorkspace.id, cwd: previewCwd, mode: "local" as const, branch: "main", archived: false, createdAt: previewNow, linkId: "pl_notes" };

export function previewSession(overrides: Partial<SessionMeta> & Pick<SessionMeta, "id" | "title">): SessionMeta {
  return {
    environmentId: "local", parentId: null, projectId: previewProject.id, workspaceId: null,
    threadType: "chat", planPath: null, provider: "claude", model: "opus-5.5",
    reasoning: "medium", agentType: "implementer", cwd: previewCwd, status: "idle",
    pinned: false, archived: false, permission: "safe", fast: false, ultrafast: false,
    context1m: false, busySince: null, pausedAt: null, frozenActiveElapsed: null,
    nativeId: null, createdAt: previewNow, updatedAt: previewNow, ...overrides,
  };
}

type PreviewHost = {
  id: string;
  name: string;
  caps?: Hello["caps"];
  refused?: boolean;
  answers?: Record<string, (params: unknown) => unknown>;
};

export async function addPreviewHost(host: PreviewHost) {
  bindServer(registry);
  const originalSocket = globalThis.WebSocket;
  class FixtureSocket implements SocketLike {
    readyState = 1;
    onopen: SocketLike["onopen"] = null;
    onclose: SocketLike["onclose"] = null;
    onerror: SocketLike["onerror"] = null;
    onmessage: SocketLike["onmessage"] = null;

    constructor(url: string) {
      if (new URL(url).hostname !== host.id + ".preview.invalid") throw new Error("Unseeded preview host");
      queueMicrotask(() => {
        if (host.refused) this.onclose?.({ code: 4401 });
        else this.receive({ push: "hello", contract: 1, environmentId: host.id, caps: host.caps ?? ["read", "approve"], key: { id: "fixture-key", name: "Preview" } });
      });
    }

    send(data: string) {
      const { id, method, params } = JSON.parse(data);
      void Promise.resolve().then(() => {
        const answer = host.answers?.[method];
        if (!answer) throw new Error("No fixture for " + method);
        return answer(params);
      }).then(
        (result) => this.receive({ id, ok: true, result }),
        (error: unknown) => this.receive({ id, ok: false, error: error instanceof Error ? error.message : String(error) }),
      );
    }

    close() { this.readyState = 3; }

    private receive(frame: object) {
      if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(frame) });
    }
  }
  globalThis.WebSocket = FixtureSocket as unknown as typeof WebSocket;
  try {
    const link = registry.add({
      id: host.id, name: host.name, credentialRef: null,
      routes: [{ url: "ws://" + host.id + ".preview.invalid/ws", kind: "loopback", credential: "implicit" }],
    });
    await new Promise<void>((resolve) => {
      const check = () => {
        const state = registry.statusOf(host.id).transport;
        if (state !== "open" && state !== "unauthorized") return;
        off();
        resolve();
      };
      const off = registry.subscribe(check);
      check();
    });
    return link;
  } finally {
    globalThis.WebSocket = originalSocket;
  }
}

/** Press a fixture's actual control after mount. A missing trigger fails the capture. */
export function previewClick(container: ParentNode, selector: string): void {
  const target = container.querySelector<HTMLElement>(selector);
  if (!target) throw new Error(`Missing preview control: ${selector}`);
  target.click();
}

/** Set a text input as typing would, including React's input event. */
export function previewInput(root: ParentNode, label: string, text: string): void {
  const input = root.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!input) throw new Error(`Missing preview field: ${label}`);
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(input, text);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
}

export async function waitForPreview<T>(find: () => T | null | undefined): Promise<T> {
  for (let tries = 0; tries < 75; tries++) {
    const found = find();
    if (found != null) return found;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("The preview state did not arrive");
}
