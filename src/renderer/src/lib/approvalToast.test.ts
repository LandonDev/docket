import { describe, expect, it } from "vitest";
import {
  approvalToastNotice,
  pendingApprovalForSession,
} from "./approvalToast";
import { newSession, type Block } from "./session";

function block(
  role: Block["role"],
  approval?: Block["approval"],
): Block {
  return {
    id: crypto.randomUUID(),
    role,
    text: role === "tool" ? "Run command" : "Approve?",
    ...(role === "tool"
      ? { tool: { title: "Run command", kind: "execute" } }
      : {}),
    ...(approval ? { approval } : {}),
  };
}

describe("pendingApprovalForSession", () => {
  it("returns the latest undecided approval", () => {
    const session = newSession("local");
    session.blocks = [
      block("tool", { requestId: 1, decided: "allow" }),
      block("tool", { requestId: 2 }),
    ];
    const pending = pendingApprovalForSession(session);
    expect(pending?.requestId).toBe(2);
    // The call has not run: the toast says what it asks.
    expect(pending?.label).toBe("Run a command");
    expect(pending?.tool).toBe("a tool");
  });

  it("names the tool for a state's detail and keeps the long words for the toast", () => {
    const session = newSession("local");
    session.blocks = [
      {
        id: "b1",
        role: "tool",
        text: "",
        tool: { name: "Bash", kind: "execute", title: "Bash", input: { command: "touch notes.txt", description: "Create an empty notes file" } },
        approval: { requestId: 7 },
      } as Block,
    ];
    const pending = pendingApprovalForSession(session)!;
    expect(pending.tool).toBe("Bash");
    expect(pending.label).not.toBe("Bash");
  });
});

describe("approvalToastNotice", () => {
  it("keeps only toast facts and reuses them until the title or label changes", () => {
    const session = newSession("local");
    session.title = "Review";
    session.cwd = "/repo";
    session.blocks = [{ id: "a", role: "tool", text: "", approval: { requestId: 4 }, tool: { name: "Read", title: "Read", kind: "read", input: { file_path: "/repo/file.txt" } } }];
    const notice = approvalToastNotice(session)!;
    expect(approvalToastNotice({ ...session }, notice)).toBe(notice);
    expect(Object.keys(notice).sort()).toEqual(["label", "requestId", "sessionId", "title", "tool"]);
    const renamed = approvalToastNotice({ ...session, title: "Renamed" }, notice)!;
    expect(renamed).not.toBe(notice);
    expect(renamed.title).toBe("Renamed");
    const moved = approvalToastNotice({ ...session, cwd: "/elsewhere" }, notice)!;
    expect(moved).toBe(notice);
    const changed = approvalToastNotice({ ...session, blocks: [{ ...session.blocks[0], tool: { ...session.blocks[0].tool!, input: { file_path: "/repo/other.txt" } } }] }, notice)!;
    expect(changed.label).toBe("Read other.txt");
    expect(changed).not.toBe(notice);
  });

  it("keeps question-only blocks out of approval toasts", () => {
    const session = newSession("local");
    session.blocks = [{ id: "q", role: "tool", text: "Question", question: { requestId: 1, questions: [] } }];
    expect(approvalToastNotice(session)).toBeNull();
  });
});
