import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import { LspConnection } from "./connection";

vi.mock("../../../lib/connection", () => ({ localServerPort: () => 1234 }));
vi.mock("../models", () => ({ onModelSaved: () => {} }));
vi.mock("../monaco", () => ({
  monaco: {
    Emitter: class { fire() {} },
    Uri: { file: (path: string) => pathToFileURL(path) },
    editor: { removeAllMarkers: () => {}, getModels: () => [] },
    languages: { CompletionItemKind: {}, SymbolKind: {} },
    MarkerSeverity: {},
  },
}));

it("identifies the editor as Docket when it initializes a language server", async () => {
  const sent: unknown[] = [];
  class TestSocket {
    static OPEN = 1;
    readyState = TestSocket.OPEN;
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;

    constructor() {
      queueMicrotask(() => this.onopen?.());
    }

    send(json: string) {
      const frame = JSON.parse(json);
      sent.push(frame);
      if (frame.method === "initialize") {
        const data = JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { capabilities: {} } });
        queueMicrotask(() => this.onmessage?.({ data }));
      }
    }

    close() {}
  }

  vi.stubGlobal("WebSocket", TestSocket);
  const conn = new LspConnection({
    id: "project",
    workspaceId: "workspace",
    environmentId: "local",
    name: "Sample",
    mode: "local",
    branch: null,
    cwd: "/sample",
    archived: false,
    createdAt: 0,
  }, "web", "server", "/lsp/server", {});
  try {
    await conn.connect();
    expect(sent[0]).toMatchObject({ method: "initialize", params: { clientInfo: { name: "docket" } } });
    expect(sent[1]).toMatchObject({ method: "initialized" });
  } finally {
    conn.dispose();
    vi.unstubAllGlobals();
  }
});
