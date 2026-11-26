import { describe, expect, it } from "vitest";
import { settingsList, type ListWindow } from "./list";
import { searchSettings } from "./search";

const MAC: ListWindow = {
  web: false,
  platform: "darwin",
  work: true,
  has: { publish: true, winvm: true },
  computers: [
    { id: "env_box", name: "The box", platform: "linux" },
    { id: "env_pc", name: "PURDUE-LT", platform: "win32", offline: true },
  ],
  vmOn: "env_box",
  jobs: [{ id: "j1", name: "Purdue Esports", sector: "purdue", on: "The box" }],
  workspaces: [
    { id: "w1", name: "temp-code", on: "The box" },
    { id: "w2", name: "notes", on: null },
  ],
};
const WEB: ListWindow = { web: true, platform: "", work: true, has: { winvm: true }, computers: [{ id: "web", name: "The box" }], vmOn: "web", jobs: MAC.jobs, workspaces: [{ id: "w1", name: "temp-code" }] };

const labels = (window: ListWindow) => settingsList(window).map((group) => [group.label, group.rows.map((row) => row.label)] as const);
const find = (query: string, window: ListWindow = MAC) => searchSettings(query, settingsList(window));

describe("the Settings list", () => {
  it("groups a Mac's list by place, in order", () => {
    expect(labels(MAC)).toEqual([
      ["This Mac", ["General", "Appearance", "Editor", "Shortcuts", "Updates", "Appshots", "Computer use", "Threads", "Sharing", "Publish"]],
      ["Everywhere", ["New threads", "Reviews", "Subagents", "Away", "Add-ons", "Skills", "Sync", "AI accounts"]],
      // The Windows VM stands right under the computer that holds it.
      ["Other computers", ["The box", "Windows VM", "PURDUE-LT"]],
      // The Work group's first page is Setup, not Work under Work.
      ["Work", ["Setup", "Digest", "Mail", "Files", "Connections"]],
      ["Jobs", ["Purdue Esports"]],
      ["Code workspaces", ["temp-code", "notes"]],
      ["", ["Archive"]],
    ]);
  });

  it("heads the box's web page This browser and Computers, with nothing about a computer the browser is not", () => {
    expect(labels(WEB)).toEqual([
      ["This browser", ["General", "Appearance", "Editor", "Shortcuts"]],
      ["Everywhere", ["New threads", "Reviews", "Subagents", "Away", "Add-ons", "Skills"]],
      ["Computers", ["The box", "Windows VM"]],
      ["Work", ["Setup", "Digest", "Mail", "Files", "Connections"]],
      ["Jobs", ["Purdue Esports"]],
      ["Code workspaces", ["temp-code"]],
      ["", ["Archive"]],
    ]);
  });

  it("says where a row's thing is at its end, only where the rows differ: Offline, in the box, the computer a workspace is on", () => {
    const rows = settingsList(MAC).flatMap((group) => group.rows);
    const end = (label: string) => rows.find((row) => row.label === label)?.end;
    // Two workspaces on two computers: each row that is elsewhere says where.
    expect(end("temp-code")).toBe("the box");
    expect(end("notes")).toBeUndefined();
    // Every job is on the box: one word on every row says nothing.
    expect(end("Purdue Esports")).toBeUndefined();
    expect(end("PURDUE-LT")).toBe("Offline");
    expect(end("The box")).toBeUndefined();
    // Right under the box: its place says where it is.
    expect(end("Windows VM")).toBeUndefined();
  });

  it("keeps the Windows VM's row when its computer is not in the list", () => {
    const rows = settingsList({ ...MAC, vmOn: null }).find((group) => group.id === "others")!.rows.map((row) => [row.label, row.end]);
    expect(rows.at(-1)).toEqual(["Windows VM", undefined]);
  });

  it("calls the shared set Everywhere in every window, has no Sync with nothing to keep in step, and keeps the group for Add a computer…", () => {
    const alone = settingsList({ ...MAC, computers: [], has: {}, work: false, jobs: [] });
    expect(alone.map((group) => group.label)).toEqual(["This Mac", "Everywhere", "Other computers", "Work", "Code workspaces", ""]);
    expect(alone.find((group) => group.id === "others")?.rows).toEqual([]);
    expect(alone.find((group) => group.id === "every")?.rows.map((row) => row.label)).toEqual(["New threads", "Reviews", "Subagents", "Away", "Add-ons", "Skills", "AI accounts"]);
  });

  it("leaves Jobs out while Work is off everywhere", () => {
    expect(settingsList({ ...MAC, work: false }).map((group) => group.id)).not.toContain("jobs");
  });
});

describe("search", () => {
  it("finds a setting by its new name, with where it is under it", () => {
    const [first] = find("largest attach");
    expect(first).toMatchObject({ title: "Largest attachment", path: "This Mac, Threads", page: "here", row: "here.attachment" });
  });

  it("puts a page's own name first", () => {
    expect(find("away")[0]).toMatchObject({ title: "Away", path: "Everywhere", page: "away" });
    expect(find("away")[0].row).toBeUndefined();
    // A page is found by its own title as well as its row's label, and says the title.
    expect(find("work").find((result) => result.page === "work" && !result.row)).toMatchObject({ title: "Work", path: "Work" });
    expect(find("threads on this")[0]).toMatchObject({ title: "Threads on this Mac", path: "This Mac", page: "here" });
    // The group's own page is said by the group alone: no "Work, Setup".
    expect(find("start addresses")[0]?.path).toBe("Work, Travel");
  });

  it("answers an old name with the new home and says what it was", () => {
    const hosts = find("hosts");
    // Each old-name hit says what of Hosts went there, so two pages of one group read apart.
    expect(hosts.slice(0, 4).map((result) => [result.title, result.was])).toEqual([
      ["Threads on this Mac", "Was “Hosts, Running threads, Stuck after, Attachment limit”"],
      ["Sharing", "Was “Hosts, Clients, Mac bridge, Remote access”"],
      ["Publish", "Was “Hosts, Release”"],
      ["Sync", "Was “Hosts, Sync”"],
    ]);
    // The pages Hosts became, and no more: not every row that once stood on it.
    expect(hosts.map((result) => result.title)).toEqual(["Threads on this Mac", "Sharing", "Publish", "Sync", "The box", "PURDUE-LT"]);
    expect(find("hosts sync").map((result) => result.title)).toEqual(expect.arrayContaining(["Sync", "Agent settings", "Agents' memory"]));
    expect(find("harness config")[0]).toMatchObject({ title: "Agent settings", page: "sync", row: "sync.settings", was: "Was “Hosts, Sync, Harness config”" });
    expect(find("ghost text")[0]).toMatchObject({ title: "Inline suggestions", was: "Was “Editor, Completions, Ghost text”" });
    expect(find("preamble")[0]).toMatchObject({ title: "Rules read before the first message", page: "ws:w1" });
  });

  it("says no old name when the new one matched", () => {
    expect(find("largest attachment").every((result) => result.was === undefined)).toBe(true);
  });

  it("lists a per-computer setting once for each computer, which shows its scope", () => {
    const hits = find("threads at once").filter((result) => result.title === "Threads at once");
    // A computer is its own place: its rows say its name, not the heading it stands under.
    expect(hits.map((result) => result.path)).toEqual(["This Mac, Threads", "Threads on the box", "Threads on PURDUE-LT"]);
    expect(hits.map((result) => result.page)).toEqual(["here", "computer:env_box", "computer:env_pc"]);
    // What another computer may do on this Mac is this Mac's rule: once per computer, on Sharing.
    expect(find("files and commands").map((result) => result.computer)).toEqual(["env_box", "env_pc"]);
    expect(find("files and commands").map((result) => result.path)).toEqual(["What the box may do on this Mac", "What PURDUE-LT may do on this Mac"]);
  });

  it("lists a job's and a workspace's rows under that job and workspace", () => {
    expect(find("learn how i write")[0]).toMatchObject({ path: "Purdue Esports, Writing and mail", page: "ws:j1", row: "job.voice" });
    expect(find("run the checks")[0]).toMatchObject({ path: "temp-code, After each turn", page: "ws:w1" });
  });

  it("finds nothing on a page this window cannot show", () => {
    expect(find("release folder", WEB)).toEqual([]);
    expect(find("release folder")[0]?.page).toBe("publish");
    expect(find("agent settings", WEB)).toEqual([]);
  });

  it("matches every typed word in any order and any case, and nothing for nothing", () => {
    expect(find("STUCK thread")[0]?.title).toBe("Tell me a thread is stuck after");
    expect(find("   ")).toEqual([]);
    expect(find("zzzz")).toEqual([]);
  });

  it("fills this window's words into a name", () => {
    expect(searchSettings("awake", settingsList({ ...MAC, platform: "win32" }), { mac: "this PC" })[0]?.title).toBe("Keep this PC awake");
  });

  it("lists a row only where its page draws it: nothing for the capture key with Work off, or in a browser", () => {
    const groups = settingsList(MAC);
    expect(searchSettings("open capture", groups, {}, [], { web: false, mac: true, work: true })[0]).toMatchObject({ page: "keybindings", row: "keys.capture" });
    expect(searchSettings("open capture", groups, {}, [], { web: false, mac: true, work: false })).toEqual([]);
    expect(searchSettings("open capture", settingsList(WEB), {}, [], { web: true, mac: false, work: true })).toEqual([]);
    expect(searchSettings("appshot", groups, {}, [], { web: false, mac: false, work: true }).some((result) => result.row === "keys.appshot")).toBe(false);
  });

  it("says no old home for Away's switches: the rail's switch still stands", () => {
    expect(find("code threads").find((result) => result.row === "away.code")?.was).toBeUndefined();
  });

  it("finds an add-on or a skill by its name", () => {
    const hits = searchSettings("linear", settingsList(MAC), {}, [{ title: "linear", page: "addons", path: "Everywhere, Add-ons" }]);
    expect(hits.map((result) => result.title)).toContain("linear");
  });
});
