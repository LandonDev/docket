import { describe, expect, it } from "vitest";
import { settingsList, type ListWindow } from "./list";
import { ADD_COMPUTER_RESULT, SIGN_IN_NAMES, searchSettings, type SearchWindow } from "./search";

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
    expect(first).toMatchObject({ title: "Largest attachment", path: "Threads on this Mac", page: "here", row: "here.attachment" });
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
    expect(hosts.slice(0, 5).map((result) => [result.title, result.was])).toEqual([
      ["Updates", "Was “Hosts, Release, Code updates”"],
      ["Threads on this Mac", "Was “Hosts, Running threads, Stuck after, Attachment limit”"],
      ["Sharing", "Was “Hosts, Clients, Mac bridge, Remote access”"],
      ["Publish", "Was “Hosts, Release”"],
      ["Sync", "Was “Hosts, Sync”"],
    ]);
    // The pages Hosts became, and no more: not every row that once stood on it.
    expect(hosts.map((result) => result.title)).toEqual(["Updates", "Threads on this Mac", "Sharing", "Publish", "Sync", "The box", "PURDUE-LT"]);
    // A computer's page names the computer it was, never "a host".
    expect(hosts.find((result) => result.title === "The box")?.was).toBe("Was “Hosts, The box”");
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
    expect(hits.map((result) => result.path)).toEqual(["Threads on this Mac", "Threads on the box", "Threads on PURDUE-LT"]);
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

describe("rows a window cannot draw", () => {
  it("lists the capture key only where Work is on for this computer, and another computer's own-Mac rows only on a desktop", () => {
    const at = (window: SearchWindow, query: string) => searchSettings(query, settingsList(MAC), { mac: "this Mac" }, [], window).map((r) => r.row);
    expect(at({ work: true, workHere: false }, "open capture")).not.toContain("keys.capture");
    expect(at({ work: true, workHere: true }, "open capture")).toContain("keys.capture");
    expect(at({ web: true }, "addresses")).not.toContain("pc.addresses");
    expect(at({}, "addresses")).toContain("pc.addresses");
  });
  it("finds Updates and Sharing by what Hosts held", () => {
    const pages = searchSettings("code updates", settingsList(MAC), { mac: "this Mac" }, []).map((r) => r.page);
    expect(pages).toContain("updates");
  });
});

describe("sign-ins by name", () => {
  it("finds LifeOS's sign-in on Connections", () => {
    const results = searchSettings("lifeos", settingsList(MAC), { mac: "this Mac" }, SIGN_IN_NAMES);
    expect(results.map((result) => [result.title, result.page])).toContainEqual(["LifeOS sign-in", "connections"]);
  });
});

describe("a press found by its old name", () => {
  it("finds Add a computer… by Hosts' Add host", () => {
    const results = searchSettings("add host", settingsList(MAC), { mac: "this Mac" }, [ADD_COMPUTER_RESULT]);
    expect(results[0]).toMatchObject({ title: "Add a computer…", act: "add-computer", was: "Was “Hosts, Add host”" });
    expect(searchSettings("hosts", settingsList(MAC), { mac: "this Mac" }, [ADD_COMPUTER_RESULT]).map((result) => result.title)).toContain("Add a computer…");
  });
});

describe("a computer's rows by an old name", () => {
  it("name the computer they were on, and list its jobs only where it holds some", () => {
    const pair = searchSettings("pair a device", settingsList(MAC), { mac: "this Mac" });
    expect(pair.map((result) => result.was)).toEqual(expect.arrayContaining(["Was “Hosts, the box, Pair a device…”"]));
    expect(pair.every((result) => !result.was?.includes("host,") && !result.was?.includes("a host"))).toBe(true);
    const jobs = (jobsOn: string[]) => searchSettings("access for each job", settingsList(MAC), { mac: "this Mac" }, [], { work: true, jobsOn }).filter((result) => result.row === "pc.jobs").map((result) => result.page);
    expect(jobs([])).toEqual([]);
    expect(jobs(["env_box"])).toEqual(["computer:env_box"]);
  });
});

describe("rows search names as their page does", () => {
  it("names a counted row without a blank count, and offers where new jobs are made only with two computers on Work", () => {
    const titles = (query: string, window = {}) => searchSettings(query, settingsList(MAC), { mac: "this Mac" }, [], window).map((result) => result.title);
    expect(titles("different")).toContain("Different from New threads");
    expect(titles("different").some((title) => /Different in\s+places/.test(title))).toBe(false);
    expect(titles("new jobs are made", { work: true, workCount: 1 })).not.toContain("New jobs are made on");
    expect(titles("new jobs are made", { work: true, workCount: 2 })).toContain("New jobs are made on");
  });
});

describe("the overrides row in search", () => {
  it("is found by the page's words and only where a place may keep its own set", () => {
    const rows = (query: string, window = {}) => searchSettings(query, settingsList(MAC), { mac: "this Mac" }, [], window).map((result) => result.row);
    expect(rows("different in places")).toContain("defaults.different");
    expect(rows("different in 2 places")).toContain("defaults.different");
    expect(rows("different from new threads", { placesDiffer: false })).not.toContain("defaults.different");
    // Reviews' exceptions row is drawn only once every project answered: search offers the page, not the row.
    expect(rows("projects that differ from reviews")).not.toContain("reviews.different");
    // …and the Reviews page stands for it, by its words and with its count typed.
    const pages = (query: string) => searchSettings(query, settingsList(MAC), { mac: "this Mac" }).map((result) => result.page);
    expect(pages("projects that differ from reviews")).toContain("reviews");
    expect(pages("different in projects")).toContain("reviews");
    expect(pages("different in 1 project")).toContain("reviews");
  });
});
