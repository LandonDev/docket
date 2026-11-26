// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectModalShape } from "../../chrome/modalShape.testkit";

const host = vi.hoisted(() => ({
  accept: null as null | (() => void),
  refuse: null as null | ((e: Error) => void),
  acceptCalls: 0,
  lsp: null as null | ((rows: unknown[]) => void),
  eula: null as null | ((eula: { build: string; text: string }) => void),
  check: null as null | ((r: { current: string; latest: string; updated: boolean }) => void),
  engine: undefined as undefined | { dist: boolean; accepted: boolean; build: string },
  editor: null as null | { editor: string; effective: string | null; installed: Record<string, boolean> },
  doctorFails: false,
}));

vi.mock("../../lib/connection", () => {
  const link = {
    connected: true,
    onOpen: () => () => {},
    request: (method: string) =>
        method === "idea.acceptEula"
          ? new Promise<void>((resolve, reject) => { host.accept = resolve; host.refuse = reject; host.acceptCalls++; })
          : method === "lsp.status"
          ? new Promise((resolve) => (host.lsp = resolve))
          : method === "idea.eula"
            ? new Promise((resolve) => (host.eula = resolve))
            : method === "idea.checkUpdate"
              ? new Promise((resolve) => (host.check = resolve))
              : host.doctorFails
                ? Promise.reject(new Error("The host did not answer"))
                : Promise.resolve({ java: { found: true, version: "21", jdtls: true, path: "/usr/lib/jvm/21", ideaServer: host.engine } }),
  };
  return { registry: { primary: () => link } };
});
vi.mock("../../lib/tcserver/workspaces", () => ({ useProjects: () => [{ id: "p1", name: "Alpha" }] }));
const chooseEditor = vi.hoisted(() => vi.fn(async () => null));
const editorRead = vi.hoisted(() => ({ answer: null as unknown, asks: 0 }));
vi.mock("../../lib/editorConfig", () => ({
  useEditorConfig: () => host.editor,
  chooseEditorSetting: chooseEditor,
  loadEditorConfig: () => {
    editorRead.asks += 1;
    return editorRead.answer === "pending" ? new Promise(() => {}) : Promise.resolve(editorRead.answer);
  },
}));
vi.mock("../../components/choice-select", async () => await import("../../components/choice-select-body"));
vi.mock("../../lib/monaco/lspGate", () => ({ retryBlockedEnsures: vi.fn() }));
vi.mock("../../lib/sounds", () => ({ playCue: vi.fn() }));
vi.mock("../../lib/settings/computerName", () => ({ useComputerName: () => ({ name: "MacBook Pro", own: true }), computerInLine: () => "this Mac" }));

const { EditorPage, serverWords } = await import("./Editor");

beforeEach(() => {
  host.accept = null;
  host.acceptCalls = 0;
  host.lsp = null;
  host.editor = null;
  host.doctorFails = false;
  editorRead.answer = null;
  editorRead.asks = 0;
});
afterEach(cleanup);

const headings = () => screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);

describe("Editor", () => {
  it("lays out its sections, Other editors with its config, its shape while main answers and one line with Retry if not", async () => {
    editorRead.answer = "pending";
    render(<EditorPage />);
    await act(async () => {});
    expect(headings()).toEqual(["Saving", "Suggestions", "Other editors", "Java on this Mac"]);
    expect(screen.getByRole("region", { name: "Other editors" }).querySelectorAll("[data-slot=page-row-skeleton]")).toHaveLength(1);
    cleanup();
    editorRead.answer = null;
    render(<EditorPage />);
    await act(async () => {});
    const others = screen.getByRole("region", { name: "Other editors" });
    expect(within(others).getByRole("alert").textContent).toBe("Could not read the editors on this Mac");
    editorRead.answer = { editor: "auto", effective: "code", installed: { idea: false, code: true, xed: false } };
    await act(async () => fireEvent.click(within(others).getByRole("button", { name: "Retry" })));
    expect(screen.getByText("Auto opens VS Code")).toBeTruthy();
    cleanup();
    cleanup();
    host.editor = { editor: "auto", effective: "code", installed: { idea: false, code: true, xed: false } };
    render(<EditorPage />);
    await act(async () => {});
    expect(headings()).toEqual(["Saving", "Suggestions", "Other editors", "Java on this Mac"]);
    expect(screen.getByText("Auto opens VS Code")).toBeTruthy();
  });

  it("writes each Saving and Suggestions row to its own key at once", async () => {
    localStorage.clear();
    render(<EditorPage />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("switch", { name: "Save as I type" }));
    expect(localStorage.getItem("docket.editor.autoSave")).not.toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "Format Java and Kotlin on save" }));
    expect(JSON.parse(localStorage.getItem("docket.editor.formatOnSave") ?? "{}").java).toBe(true);
    fireEvent.click(screen.getByRole("switch", { name: "Inline suggestions" }));
    expect(localStorage.getItem("docket.editor.ghostText")).not.toBeNull();
  });

  it("hands Open files in to this computer's editor setting with the save mark", async () => {
    host.editor = { editor: "auto", effective: "code", installed: { idea: false, code: true, xed: false } };
    render(<EditorPage />);
    await act(async () => {});
    fireEvent.click(screen.getByLabelText("Open files in"));
    await act(async () => {});
    const option = await screen.findByRole("option", { name: "VS Code" });
    await act(async () => {
      fireEvent.pointerDown(option, { pointerType: "mouse", button: 0 });
      fireEvent.click(option);
    });
    expect(chooseEditor).toHaveBeenCalledWith("code");
    expect(document.querySelector('[data-setting="editor.openIn"] [data-slot=save-mark]')?.getAttribute("data-state")).toBe("saved");
  });

  it("names no engine verb before the doctor answers: the button's place is a skeleton", () => {
    render(<EditorPage />);
    const java = screen.getByRole("region", { name: "Java on this Mac" });
    expect(java.querySelector("[data-engine-action]")).toBeTruthy();
    expect(within(java).queryByRole("button")).toBeNull();
  });

  it("never says No JDK found when doctor.get fails: the error and Retry", async () => {
    host.doctorFails = true;
    render(<EditorPage />);
    await act(async () => {});
    const java = screen.getByRole("region", { name: "Java on this Mac" });
    expect(java.textContent).not.toContain("No JDK found");
    expect(java.textContent).not.toContain("Not downloaded");
    expect(java.querySelector("[role=alert]")?.textContent).toBe("The host did not answer");
    host.doctorFails = false;
    await act(async () => fireEvent.click(within(java).getByRole("button", { name: "Retry" })));
    expect(java.textContent).toContain("21, language support ready");
  });

  it("adds nothing to the Java rows when lsp.status fails, and never says a server is idle that it did not report", async () => {
    render(<EditorPage />);
    await act(async () => {});
    await act(async () => (host.lsp as unknown as (v: unknown) => void)(Promise.reject(new Error("refused"))));
    const java = screen.getByRole("region", { name: "Java on this Mac" });
    expect(java.textContent).toContain("21, language support ready");
    expect(java.textContent).not.toContain("running for");
    expect(within(java).queryByRole("alert")).toBeNull();
  });

  it("asks the servers again every 5 s only once the first answer is in", async () => {
    vi.useFakeTimers();
    try {
      render(<EditorPage />);
      const first = host.lsp;
      await act(async () => vi.advanceTimersByTime(10_000));
      expect(host.lsp).toBe(first);
      await act(async () => host.lsp?.([]));
      const before = host.lsp;
      await act(async () => vi.advanceTimersByTime(5_000));
      expect(host.lsp).not.toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it("folds each Java server into its row: the projects it runs for and its memory, its failure as the row's red line", async () => {
    host.engine = { dist: true, accepted: true, build: "263.1" };
    render(<EditorPage />);
    await act(async () => {});
    await act(async () =>
      host.lsp?.([
        { serverId: "s1", lang: "java", projectId: "p1", state: "running", memoryBytes: 512 * 1024 ** 2, idleMs: 180_000 },
        { serverId: "s2", lang: "idea", projectId: "p1", state: "error", error: "Exited 1", idleMs: 0 },
        { serverId: "s3", lang: "web", projectId: "p1", state: "running", memoryBytes: 1, idleMs: 0 },
      ]),
    );
    const jdk = document.querySelector('[data-setting="editor.jdk"]') as HTMLElement;
    expect(jdk.textContent).toContain("21, language support ready, running for Alpha, 512 MB");
    expect(jdk.textContent).not.toContain("p1");
    const engine = document.querySelector('[data-setting="editor.intellij"]') as HTMLElement;
    expect(engine.textContent).toContain("Build 263.1");
    expect(screen.getByText("Exited 1").className).toContain("text-destructive");
    expect(screen.queryByText("Language servers")).toBeNull();
    host.engine = undefined;
  });

  it("shows the JDK once the doctor answers", async () => {
    render(<EditorPage />);
    await act(async () => {});
    expect(screen.getByText("21, language support ready")).toBeTruthy();
  });

  it("never names a project by its id: one it cannot name is left out", () => {
    expect(serverWords([{ state: "running", projectId: "p9", memoryBytes: 1024 ** 3, idleMs: 0 } as never], new Map()).line).toBe("running, 1.0 GB");
  });

  it("words what a kind of server is doing", () => {
    const names = new Map([["p1", "Alpha"], ["p2", "Beta"]]);
    expect(serverWords([], names)).toEqual({ line: null, error: null });
    expect(serverWords([{ state: "starting", projectId: "p1", idleMs: 0 } as never], names)).toEqual({ line: "starting", error: null });
    expect(
      serverWords(
        [
          { state: "running", projectId: "p1", memoryBytes: 1024 ** 3, idleMs: 0 } as never,
          { state: "running", projectId: "p2", memoryBytes: 512 * 1024 ** 2, idleMs: 0 } as never,
        ],
        names,
      ).line,
    ).toBe("running for Alpha and Beta, 1.5 GB");
  });

  it("reads the EULA in a dialog: a spinner while it downloads, then the text, Cancel and the verb", async () => {
    render(<EditorPage />);
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Read the licence…" }));
    });
    const dialog = await screen.findByRole("dialog");
    expect(screen.getByRole("heading", { name: "JetBrains licence" })).toBeTruthy();
    expect(dialog.querySelector("[data-slot=spinner]")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Accept and turn on" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => host.eula?.({ build: "263.1", text: "You may use it." }));
    expect(screen.getByText("You may use it.")).toBeTruthy();
    expect(screen.getByText("IntelliJ engine, build 263.1")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Accept and turn on" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole("button", { name: "Cancel" }).dataset.variant).toBe("secondary");
    expectModalShape(dialog);
  });

  it("holds Accept and turn on's width and sends once while acceptance waits", async () => {
    host.engine = { dist: true, accepted: false, build: "263.1" };
    render(<EditorPage />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Read the licence…" }));
    await act(async () => host.eula?.({ build: "263.1", text: "You may use it." }));
    const accept = screen.getByRole<HTMLButtonElement>("button", { name: "Accept and turn on" });
    const widths = accept.querySelector("[data-slot=busy-label]")!.className;
    fireEvent.click(accept);
    fireEvent.click(accept);
    expect(host.acceptCalls).toBe(1);
    expect(accept.disabled).toBe(true);
    expect(accept.querySelector("[data-slot=busy-label]")!.className).toBe(widths);
    expect(accept.querySelector("[data-slot=busy-label]")!.getAttribute("data-busy")).toBe("true");
    await act(async () => host.accept?.());
    host.engine = undefined;
  });

  it("says a refused acceptance inside the dialog, not on the row behind it", async () => {
    host.engine = { dist: true, accepted: false, build: "263.1" };
    render(<EditorPage />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Read the licence…" }));
    await act(async () => host.eula?.({ build: "263.1", text: "You may use it." }));
    fireEvent.click(screen.getByRole("button", { name: "Accept and turn on" }));
    await act(async () => host.refuse?.(new Error("disk full")));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("disk full");
    expect(screen.getByText("disk full").className).toContain("text-destructive");
    // The license stays readable above the error.
    expect(dialog.textContent).toContain("You may use it.");
    host.engine = undefined;
  });

  it("shows a spinner in Check for update while it checks", async () => {
    host.engine = { dist: true, accepted: true, build: "263.1" };
    render(<EditorPage />);
    await act(async () => {});
    const check = screen.getByRole("button", { name: /Check for update/ });
    await act(async () => {
      fireEvent.click(check);
    });
    expect(check.querySelector("[data-slot=spinner]")).toBeTruthy();
    expect((check as HTMLButtonElement).disabled).toBe(true);
    await act(async () => host.check?.({ current: "263.1", latest: "263.1", updated: false }));
    expect(check.querySelector("[data-slot=spinner]")).toBeNull();
    expect(screen.getByText("Up to date.")).toBeTruthy();
    host.engine = undefined;
  });
});
