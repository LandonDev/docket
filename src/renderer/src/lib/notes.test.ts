import { describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ fail: false }));
vi.mock("./native", () => ({
  invokeOn: vi.fn(async () => {
    if (native.fail) throw new Error("connect ECONNREFUSED 127.0.0.1:8787");
    return [{ id: "a", slug: "a", title: "A", body: "", createdAt: 1, updatedAt: 1 }];
  }),
}));
import {
  appendNoteReference,
  composeNoteMessage,
  injectNotePrompt,
  invalidateNotes,
  isNoteMentionPath,
  loadNotes,
  noteCardMeta,
  noteMentionLabel,
  notePreview,
  noteSourceProject,
  noteSlugsInText,
  notesAsProjectFiles,
  noteTitle,
  rankNoteFiles,
  readNotes,
  type Note,
} from "./notes";

function note(partial: Partial<Note> & Pick<Note, "id" | "slug" | "title">): Note {
  return {
    body: "",
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  };
}

describe("noteTitle", () => {
  it("uses the first heading", () => {
    expect(noteTitle("intro\n# Auth approach\n\nbody")).toBe("Auth approach");
  });

  it("falls back to the first prose line", () => {
    expect(noteTitle("Ship the notes overlay first.")).toBe(
      "Ship the notes overlay first.",
    );
  });

  it("returns Untitled when empty", () => {
    expect(noteTitle("   \n```\ncode\n```\n")).toBe("Untitled");
  });
});

describe("notePreview", () => {
  it("skips the title heading", () => {
    expect(notePreview("# Auth\n\nKeep it global.", "Auth")).toBe(
      "Keep it global.",
    );
  });
});

describe("noteSourceProject", () => {
  it("uses the folder name", () => {
    expect(noteSourceProject("/Users/me/code/agent-terminal")).toBe(
      "agent-terminal",
    );
  });

  it("returns null when there is no project", () => {
    expect(noteSourceProject(undefined)).toBeNull();
    expect(noteSourceProject("~")).toBeNull();
    expect(noteSourceProject("/")).toBeNull();
  });
});

describe("note mentions", () => {
  it("collects unique @note/slug tokens", () => {
    expect(noteSlugsInText("See @note/auth and @note/auth plus @note/plan-2.")).toEqual(
      ["auth", "plan-2"],
    );
  });

  it("injects referenced bodies after the prompt", () => {
    expect(
      injectNotePrompt("Use this.", [
        note({
          id: "n1",
          slug: "auth",
          title: "Auth",
          body: "Use a cookie.",
        }),
      ]),
    ).toBe('Use this.\n\n---\nReferenced note "Auth":\n\nUse a cookie.');
  });

  it("maps notes to mention files", () => {
    const files = notesAsProjectFiles([
      note({ id: "abc", slug: "auth", title: "Auth" }),
    ]);
    expect(files[0]).toEqual({
      name: "Auth",
      path: "note:abc",
      relative: "note/auth",
    });
    expect(isNoteMentionPath(files[0]!.path)).toBe(true);
    expect(noteMentionLabel(note({ id: "abc", slug: "auth", title: "Auth" }))).toBe(
      "note/auth",
    );
  });
});

describe("composeNoteMessage", () => {
  const card = {
    id: "n1",
    slug: "auth",
    title: "Auth",
    body: "Use a cookie.",
  };

  it("sends a lead-in plus the note when the textarea is empty", () => {
    expect(composeNoteMessage(card, "  ")).toBe(
      'Use this note.\n\n---\nReferenced note "Auth":\n\nUse a cookie.',
    );
  });

  it("keeps the user's message and appends the note", () => {
    expect(composeNoteMessage(card, "Start with the cookie.")).toBe(
      'Start with the cookie.\n\n---\nReferenced note "Auth":\n\nUse a cookie.',
    );
  });

  it("passes the draft through when there is no card", () => {
    expect(composeNoteMessage(undefined, " hello ")).toBe("hello");
  });
});

describe("noteCardMeta", () => {
  it("drops the body so the thread chip can persist without the prompt dump", () => {
    expect(
      noteCardMeta({
        id: "n1",
        slug: "overview",
        title: "Overview",
        body: "long secret body",
        sourceCwd: "/tmp/project",
      }),
    ).toEqual({
      id: "n1",
      slug: "overview",
      title: "Overview",
      sourceCwd: "/tmp/project",
    });
  });
});

describe("appendNoteReference", () => {
  it("separates from existing draft text", () => {
    expect(appendNoteReference("hello", "Auth", "Use a cookie.")).toBe(
      "hello\n\nNote: Auth\n\nUse a cookie.\n\n",
    );
    expect(appendNoteReference("", "Auth", "Use a cookie.")).toBe(
      "Note: Auth\n\nUse a cookie.\n\n",
    );
  });
});

describe("rankNoteFiles", () => {
  const notes = [
    note({ id: "a", slug: "alpha", title: "Alpha", updatedAt: 2 }),
    note({ id: "b", slug: "beta", title: "Beta plan", updatedAt: 3 }),
  ];

  it("keeps recency order without a query", () => {
    expect(rankNoteFiles(notes, "").map((file) => file.path)).toEqual([
      "note:b",
      "note:a",
    ]);
  });

  it("fuzzy-matches titles", () => {
    expect(rankNoteFiles(notes, "plan").map((file) => file.path)).toEqual([
      "note:b",
    ]);
  });
});

describe("noteMentionLabel", () => {
  it("prefixes the slug", () => {
    expect(noteMentionLabel(note({ id: "n", slug: "auth", title: "Auth" }))).toBe(
      "note/auth",
    );
  });
});

// council 5 S F7.1: the Notes page learns a read failed; a picker still gets the last good list.
describe("readNotes and loadNotes", () => {
  it("readNotes rejects a failed read, loadNotes answers the last good list or none", async () => {
    invalidateNotes();
    native.fail = true;
    try {
      await expect(readNotes("h1", true)).rejects.toThrow("ECONNREFUSED");
      await expect(loadNotes("h1", true)).resolves.toEqual([]);
      native.fail = false;
      expect((await readNotes("h2", true)).map((n) => n.id)).toEqual(["a"]);
      native.fail = true;
      await expect(readNotes("h2", true)).rejects.toThrow();
      expect((await loadNotes("h2", true)).map((n) => n.id)).toEqual(["a"]);
    } finally {
      native.fail = false;
      invalidateNotes();
    }
  });
});
