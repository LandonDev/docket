import { describe, expect, it } from "vitest";
import { newSession } from "./session";
import type { SessionSummary } from "./sessionStore";
import {
  conversationRowsFrom,
  filterHitsByProject,
  flattenGrouped,
  groupHits,
  hitsFromContentMatches,
  hitsFromSessionSearch,
  mergeHits,
  plainSnippet,
  searchConversationTitles,
  searchRecentProjects,
  searchSessionMessages,
  snippetAround,
  type AppSearchHit,
} from "./appSearch";

function summary(
  id: string,
  cwd: string,
  title: string,
  updatedAt = 1,
): SessionSummary {
  return {
    id,
    cwd,
    harness: "cursor",
    model: "gpt-5",
    runtimeMode: "supervised",
    title,
    createdAt: updatedAt,
    updatedAt,
    additions: 0,
    deletions: 0,
  };
}

describe("snippetAround", () => {
  it("keeps a short string", () => {
    expect(snippetAround("hello world", "hello")).toBe("hello world");
  });

  it("trims around a later match", () => {
    const text = `${"alpha ".repeat(20)}sidebar chips ${"omega ".repeat(20)}`;
    const snippet = snippetAround(text, "sidebar");
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet).toContain("sidebar chips");
  });

  it("starts and ends on a word's edge, never mid-word", () => {
    const text = `${"lorem ipsumdolor ".repeat(6)}the gateway test ${"consectetur adipiscing ".repeat(6)}`;
    const snippet = snippetAround(text, "gateway");
    const words = new Set(text.split(" "));
    const inner = snippet.replace(/^…/, "").replace(/…$/, "").split(" ");
    expect(words.has(inner[0])).toBe(true);
    expect(words.has(inner[inner.length - 1])).toBe(true);
    expect(snippet).toContain("gateway");
  });
});

describe("plainSnippet", () => {
  it("drops heading, emphasis, code, quote, list and link marks", () => {
    expect(plainSnippet("## What I found **two** things in `gateway.ts`")).toBe("What I found two things in gateway.ts");
    expect(plainSnippet("…the room ## Find - first *one* and [the docs](https://x.y/z)")).toBe("…the room Find first one and the docs");
    expect(plainSnippet("> quoted __bold__ line")).toBe("quoted bold line");
    expect(plainSnippet("1. Step one, then 2. step two")).toBe("Step one, then 2. step two");
    expect(plainSnippet("snake_case_name stays")).toBe("snake_case_name stays");
  });
});

describe("searchConversationTitles", () => {
  it("fuzzy-matches display titles", () => {
    const hits = searchConversationTitles(
      [
        {
          id: "s1",
          cwd: "/tmp/a",
          harness: "cursor",
          title: "cursor · Fix sidebar search",
          updatedAt: 10,
        },
        {
          id: "s2",
          cwd: "/tmp/a",
          harness: "cursor",
          title: "cursor · Unrelated",
          updatedAt: 11,
        },
      ],
      "side srch",
    );
    expect(hits.map((hit) => hit.sessionId)).toEqual(["s1"]);
    expect(hits[0]?.title).toBe("Fix sidebar search");
  });

  it("carries the thread's type for its glyph, and leaves it out when the row has none", () => {
    const hits = searchConversationTitles(
      [
        { id: "p", cwd: "/tmp/a", harness: "claude", threadType: "planning", title: "Plan the rail", updatedAt: 2 },
        { id: "c", cwd: "/tmp/a", harness: "claude", title: "Rail question", updatedAt: 1 },
      ],
      "rail",
    );
    expect(hits.find((hit) => hit.sessionId === "p")?.threadType).toBe("planning");
    expect(hits.find((hit) => hit.sessionId === "c")).not.toHaveProperty("threadType");
  });
});

describe("searchSessionMessages", () => {
  it("finds matching user and assistant text", () => {
    const session = newSession("local", "cursor", "/tmp/a");
    session.blocks = [
      { id: "u1", role: "user", text: "Please search the sidebar filter chips" },
      { id: "a1", role: "assistant", text: "Opening the explorer next." },
      { id: "r1", role: "reasoning", text: "sidebar internals" },
    ];
    const hits = searchSessionMessages(
      [
        {
          id: session.id,
          cwd: session.cwd,
          harness: session.harness,
          title: session.title,
          updatedAt: 1,
          blocks: session.blocks,
        },
      ],
      "sidebar",
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.blockId).toBe("u1");
    expect(hits[0]?.preview.toLowerCase()).toContain("sidebar");
  });

  it("matches the person's and the model's words alone, as the host's index does: a tool row is no message hit", () => {
    const blocks = [
      { id: "t1", role: "tool", text: "", tool: { kind: "read", title: "Read", detail: "/srv/x/gateway.test.ts", preview: { path: "/srv/x/gateway.test.ts" } } },
      { id: "p1", role: "plan", text: "gateway plan" },
      { id: "a1", role: "assistant", text: "## Found\n\nThe **gateway** test is flaky." },
    ] as never;
    const hits = searchSessionMessages([{ id: "s", cwd: "/w", harness: "claude", title: "T", updatedAt: 1, blocks }], "gateway");
    expect(hits.map((hit) => hit.blockId)).toEqual(["a1"]);
    expect(hits[0]?.preview).toBe("Found The gateway test is flaky.");
  });
});

describe("searchRecentProjects", () => {
  it("matches project folder names", () => {
    const hits = searchRecentProjects(
      [
        { path: "/Users/me/code/agent-terminal", openedAt: 2 },
        { path: "/Users/me/code/other", openedAt: 1 },
      ],
      "agent term",
    );
    expect(hits.map((hit) => hit.name)).toEqual(["agent-terminal"]);
  });

  it("finds and names a workspace by the rail's name, and still by its folder", () => {
    const recents = [
      { path: "/Users/me/code/practice-gateway", openedAt: 2 },
      { path: "/Users/me/code/other", openedAt: 1 },
    ];
    const nameOf = (path: string) => (path.endsWith("practice-gateway") ? "Proof gateway" : null);
    const byName = searchRecentProjects(recents, "proof", nameOf);
    expect(byName.map((hit) => hit.name)).toEqual(["Proof gateway"]);
    expect(byName[0].positions.length).toBeGreaterThan(0);
    // The folder's name still finds it (through its path), shown by the workspace's name, nothing marked.
    const byFolder = searchRecentProjects(recents, "practice", nameOf);
    expect(byFolder.map((hit) => hit.name)).toEqual(["Proof gateway"]);
    expect(byFolder[0].positions).toEqual([]);
    expect(searchRecentProjects(recents, "other", nameOf).map((hit) => hit.name)).toEqual(["other"]);
  });
});

describe("merge and group", () => {
  it("dedupes by id and keeps the higher score", () => {
    const low: AppSearchHit = {
      id: "conversation:s1",
      kind: "conversation",
      sessionId: "s1",
      cwd: "/tmp/a",
      harness: "cursor",
      title: "One",
      updatedAt: 1,
      score: 4,
      positions: [],
    };
    const high = { ...low, score: 20, title: "Better" };
    const merged = mergeHits([low], [high]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ title: "Better", score: 20 });
  });

  it("limits each section for the all scope", () => {
    const files = Array.from({ length: 20 }, (_, index) => ({
      id: `file:${index}`,
      kind: "file" as const,
      path: `/tmp/a/${index}.ts`,
      relative: `${index}.ts`,
      name: `${index}.ts`,
      score: 10,
      positions: [],
    }));
    const grouped = groupHits(files, "all");
    expect(grouped.files).toHaveLength(10);
    expect(flattenGrouped(grouped)).toHaveLength(10);
  });

  it("hides non-file hits in the files scope", () => {
    const grouped = groupHits(
      [
        {
          id: "project:/tmp/a",
          kind: "project",
          path: "/tmp/a",
          name: "a",
          score: 10,
          positions: [],
        },
        {
          id: "file:1",
          kind: "file",
          path: "/tmp/a/one.ts",
          relative: "one.ts",
          name: "one.ts",
          score: 8,
          positions: [],
        },
      ],
      "files",
    );
    expect(grouped.projects).toHaveLength(0);
    expect(grouped.files).toHaveLength(1);
  });
});

describe("hitsFromSessionSearch", () => {
  it("carries a conversation row's thread type", () => {
    const [hit] = hitsFromSessionSearch([
      { kind: "conversation", sessionId: "s1", cwd: "/tmp/a", harness: "claude", threadType: "research", title: "Survey", updatedAt: 1, preview: "" },
    ]);
    expect(hit).toMatchObject({ kind: "conversation", threadType: "research" });
  });

  it("normalizes harness titles", () => {
    const hits = hitsFromSessionSearch([
      {
        kind: "conversation",
        sessionId: "s1",
        cwd: "/tmp/a",
        harness: "cursor",
        title: "cursor · Fix search",
        updatedAt: 1,
        preview: "",
      },
      {
        kind: "message",
        sessionId: "s1",
        cwd: "/tmp/a",
        harness: "cursor",
        title: "cursor · Fix search",
        updatedAt: 1,
        blockId: "u1",
        role: "user",
        preview: "search chips",
      },
    ]);
    expect(hits[0]).toMatchObject({
      kind: "conversation",
      title: "Fix search",
    });
    expect(hits[0]).not.toHaveProperty("threadType");
    expect(hits[1]).toMatchObject({
      kind: "message",
      blockId: "u1",
      preview: "search chips",
    });
  });
});

describe("hitsFromContentMatches", () => {
  it("keeps line and preview", () => {
    const hits = hitsFromContentMatches([
      {
        path: "/tmp/a/App.tsx",
        relative: "src/App.tsx",
        line: 12,
        column: 4,
        preview: "const searchOpen = true;",
      },
    ]);
    expect(hits[0]).toMatchObject({
      kind: "content",
      name: "App.tsx",
      line: 12,
      preview: "const searchOpen = true;",
    });
  });
});

describe("conversationRowsFrom", () => {
  it("prefers live session titles over history", () => {
    const live = newSession("local", "cursor", "/tmp/a");
    live.id = "s1";
    live.title = "cursor · Live title";
    const rows = conversationRowsFrom(
      [summary("s1", "/tmp/a", "cursor · Old title", 5)],
      [live],
    );
    expect(rows).toEqual([
      expect.objectContaining({ id: "s1", title: "cursor · Live title" }),
    ]);
  });
});

describe("filterHitsByProject", () => {
  it("keeps current-project conversations", () => {
    const hits: AppSearchHit[] = [
      {
        id: "conversation:s1",
        kind: "conversation",
        sessionId: "s1",
        cwd: "/tmp/a",
        harness: "cursor",
        title: "A",
        updatedAt: 1,
        score: 1,
        positions: [],
      },
      {
        id: "conversation:s2",
        kind: "conversation",
        sessionId: "s2",
        cwd: "/tmp/b",
        harness: "cursor",
        title: "B",
        updatedAt: 1,
        score: 1,
        positions: [],
      },
    ];
    expect(
      filterHitsByProject(hits, "/tmp/a").map((hit) => hit.id),
    ).toEqual(["conversation:s1"]);
  });
});
