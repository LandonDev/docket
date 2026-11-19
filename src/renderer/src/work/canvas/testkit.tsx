import { useEffect } from "react";
import type { CanvasItem, CanvasKind, CanvasSource } from "@shared/work";
import type { ServerPush } from "@server/shared/contract";
import { defineChunk } from "../../lib/lazyChunk";
import type { CanvasBodyProps, CanvasKindDef, CanvasShell } from "./kind";
import { CANVAS } from "./registry";

/** What the canvas tests share: a host that answers `work.canvas.*` from a list, and a kind a test drives. */

export const FILE: CanvasSource = { at: "file", host: "local", path: "/work/notes.tcdoc" };

export function canvasItem(id: string, over: Partial<CanvasItem> = {}): CanvasItem {
  return { id, sessionId: "t1", workspaceId: "w1", kind: "document", title: id, source: FILE, state: "open", position: 0, rev: 0, createdAt: 1, updatedAt: 1, ...over };
}

/** A host's canvas rows for one thread, behind the link's `request`, with its pushes. */
export function fakeHost(initial: CanvasItem[] = [], wire?: { pushes: Set<(push: ServerPush) => void>; opens: Set<() => void> }) {
  let items = [...initial];
  // A test that mocks the registry hands over the sets its one link registers in.
  const pushes = wire?.pushes ?? new Set<(push: ServerPush) => void>();
  const opens = wire?.opens ?? new Set<() => void>();
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const list = (): { items: CanvasItem[] } => ({ items: items.map((item, position) => ({ ...item, position })) });
  const link = {
    environmentId: "local",
    connected: true,
    request: async (method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
      calls.push({ method, params });
      if (method === "work.canvas.list") return list();
      if (method === "work.canvas.close") {
        items = items.filter((item) => item.id !== params.itemId);
        return null;
      }
      if (method === "work.canvas.reorder") {
        const order = params.order as string[];
        items = [...order.flatMap((id) => items.find((item) => item.id === id) ?? []), ...items.filter((item) => !order.includes(item.id))];
        return list();
      }
      if (method === "work.canvas.open") {
        const made = canvasItem(`made-${items.length + 1}`, { kind: (params.kind as CanvasKind | undefined) ?? "document", title: (params.title as string | undefined) ?? "Untitled", source: (params.source as CanvasSource | undefined) ?? FILE });
        items = [...items, made];
        return made;
      }
      throw new Error(`unexpected ${method}`);
    },
    onPush: (listener: (push: ServerPush) => void) => {
      pushes.add(listener);
      return () => pushes.delete(listener);
    },
    onOpen: (listener: () => void) => {
      opens.add(listener);
      return () => opens.delete(listener);
    },
    onClose: () => () => undefined,
  };
  return {
    link,
    calls,
    /** The host changed the list: every socket hears the whole of it. */
    push(next: CanvasItem[], opened?: string): void {
      items = [...next];
      for (const listener of pushes) listener({ push: "work.canvas", sessionId: "t1", items: list().items, ...(opened ? { opened } : {}) } as ServerPush);
    },
    /** The socket came back. */
    reopen(): void {
      for (const listener of opens) listener();
    },
  };
}

/** A kind whose body hands the test its `shell`, so the test feeds the frame as a real kind would. */
export function drivenKinds(onShell: (shell: CanvasShell, props: CanvasBodyProps) => void, parts: { bar?: boolean; tabEnd?: boolean } = {}): Record<CanvasKind, CanvasKindDef> {
  function Body(props: CanvasBodyProps) {
    const { shell } = props;
    useEffect(() => {
      onShell(shell, props);
    }, [shell, props]);
    return <p data-testid="body">The body of {props.item.title}</p>;
  }
  const module = {
    Body,
    ...(parts.bar ? { Bar: () => <span data-testid="kind-tools">Zoom</span> } : {}),
    ...(parts.tabEnd ? { TabEnd: () => <span data-testid="tab-end">Excel</span> } : {}),
  };
  const chunk = defineChunk("test-kind", () => Promise.resolve(module));
  return { ...CANVAS, document: { ...CANVAS.document, chunk } };
}
