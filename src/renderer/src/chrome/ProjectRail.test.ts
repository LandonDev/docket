import { describe, expect, it } from "vitest";
import { chatsAriaLabel, projectMenuExtraItems, railFootRows, railRowAsksGit, railTopRows, workspaceRowAriaLabel } from "./ProjectRail";

describe("workspaceRowAriaLabel", () => {
  it("reads the name alone when the workspace is quiet", () => {
    expect(workspaceRowAriaLabel("Repo", false)).toBe("Repo");
  });

  it("reads working, then needs you in its place, never both", () => {
    expect(workspaceRowAriaLabel("Repo", true)).toBe("Repo, working");
    expect(workspaceRowAriaLabel("Repo", true, true)).toBe("Repo, needs you");
  });
});

describe("chatsAriaLabel", () => {
  it("names the loose chats' state, needs-you first", () => {
    expect(chatsAriaLabel(false, false)).toBe("Chats");
    expect(chatsAriaLabel(true, false)).toBe("Chats, working");
    expect(chatsAriaLabel(true, true)).toBe("Chats, needs you");
  });
});

describe("projectMenuExtraItems", () => {
  it("puts the fleet switches after Mark all read, a row with nothing to act on disabled", () => {
    const rows = projectMenuExtraItems(false, true, { pause: 2, resume: 0, stop: 2, archiveDone: 1 });
    // Separators are rows of their own: one after reveal, one before archive.
    expect(rows.map((r) => (r.kind === "item" ? r.id : "-"))).toEqual(["pin", "reveal", "-", "read", "batch-pause", "batch-resume", "batch-stop", "batch-archiveDone", "-", "archive", "delete"]);
    const items = rows.flatMap((r) => (r.kind === "item" ? [r] : []));
    expect(items.find((i) => i.id === "batch-resume")?.disabled).toBe(true);
    expect(items.find((i) => i.id === "batch-pause")?.disabled).toBe(false);
  });

  it("has no reveal in a browser, which has no file manager", () => {
    const rows = projectMenuExtraItems(false, true, null, false);
    expect(rows.some((r) => r.kind === "item" && r.id === "reveal")).toBe(false);
    expect(projectMenuExtraItems(false, true, null, true).some((r) => r.kind === "item" && r.id === "reveal")).toBe(true);
  });

  it("names the root workspace's removal Remove…, as its dialog does", () => {
    const items = projectMenuExtraItems(false, true, null).flatMap((r) => (r.kind === "item" ? [r] : []));
    expect(items.find((i) => i.id === "delete")?.label).toBe("Remove…");
  });

  it("disables every switch before the counts are known", () => {
    const items = projectMenuExtraItems(true, false, null).flatMap((r) => (r.kind === "item" ? [r] : []));
    expect(items.filter((i) => i.id.startsWith("batch-")).every((i) => i.disabled)).toBe(true);
    expect(items.map((i) => i.id)).not.toContain("archive");
  });
});

describe("railTopRows", () => {
  it("puts Work's twins beside their code ones only when told: the Outbox after Inbox, Work Chats after Chats", () => {
    const today = railTopRows({ chats: true, notes: true, aliax: true });
    expect(railTopRows({ chats: true, notes: true, aliax: true, workChats: false, outbox: false })).toEqual(today);
    expect(railTopRows({ chats: true, notes: true, aliax: true, workChats: true, outbox: true })).toEqual([
      "search",
      "inbox",
      "outbox",
      "computers",
      "read",
      "notes",
      "chats",
      "workChats",
      "accounts",
      "stats",
    ]);
  });
  it("names the Work Chats' state as the Chats' own", () => {
    expect(chatsAriaLabel(true, false, "Work Chats")).toBe("Work Chats, working");
    expect(chatsAriaLabel(false, true)).toBe("Chats, needs you");
  });

  it("is one navigation group on the desktop: Search, Inbox, Computers, Mark all read, Notes, Chats, Accounts, Stats", () => {
    expect(railTopRows({ chats: true, notes: true, aliax: true })).toEqual(["search", "inbox", "computers", "read", "notes", "chats", "accounts", "stats"]);
  });

  it("has no Accounts or Stats at /ui, where their pages cannot open", () => {
    expect(railTopRows({ chats: true, notes: true, aliax: false })).toEqual(["search", "inbox", "computers", "read", "notes", "chats"]);
  });

  it("leaves Notes out where the view cannot open", () => {
    expect(railTopRows({ chats: true, notes: false, aliax: true })).toEqual(["search", "inbox", "computers", "read", "chats", "accounts", "stats"]);
  });

  it("leaves Chats out where there is no home", () => {
    expect(railTopRows({ chats: false, notes: false, aliax: false })).toEqual(["search", "inbox", "computers", "read"]);
  });
});

describe("railFootRows", () => {
  it("is Away and Settings at /ui with one host (no updater there)", () => {
    expect(railFootRows({ signIn: false, update: false, hosts: 1 })).toEqual(["away", "settings"]);
  });

  it("on the desktop puts the update first and the hosts after it, the hosts only with two or more", () => {
    expect(railFootRows({ signIn: false, update: true, hosts: 2 })).toEqual(["update", "hosts", "away", "settings"]);
    expect(railFootRows({ signIn: false, update: true, hosts: 1 })[0]).toBe("update");
    expect(railFootRows({ signIn: false, update: false, hosts: 3 })[0]).toBe("hosts");
  });

  it("leads with the sign-in on first run, before the update, and leaves it out when there is an account", () => {
    expect(railFootRows({ signIn: true, update: true, hosts: 1 })).toEqual(["signIn", "update", "away", "settings"]);
    expect(railFootRows({ signIn: false, update: true, hosts: 1 })).not.toContain("signIn");
  });
});

describe("workspaceRowAriaLabel", () => {
  it("names the row, its state, then the selected row's uncommitted changes", () => {
    expect(workspaceRowAriaLabel("alpha", false)).toBe("alpha");
    expect(workspaceRowAriaLabel("alpha", true, true)).toBe("alpha, needs you");
    expect(workspaceRowAriaLabel("alpha", true, false, { files: 3, additions: 12, deletions: 4 })).toBe(
      "alpha, working, 3 files changed, +12, -4",
    );
    expect(workspaceRowAriaLabel("alpha", false, false, { files: 0, additions: 0, deletions: 0 })).toBe("alpha");
  });
});

describe("railRowAsksGit", () => {
  it("asks for the selected code workspace alone, never the home or a Work workspace", () => {
    expect(railRowAsksGit("/x/alpha", { kind: "code" })).toBe(true);
    expect(railRowAsksGit("/x/alpha", undefined)).toBe(true);
    expect(railRowAsksGit(null, { kind: "code" })).toBe(false);
    expect(railRowAsksGit("~", undefined)).toBe(false);
    expect(railRowAsksGit("/repo/jobs/purdue", { kind: "work" })).toBe(false);
  });
});
