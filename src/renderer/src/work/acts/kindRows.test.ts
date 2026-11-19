/** The generic view's own rows for the kinds without a view: what goes in his words, never an id, a revision, a path or JSON. */
import { describe, expect, it } from "vitest";
import { kindRows, megabytes } from "./kindRows";

const noise = (rows: ReturnType<typeof kindRows>) => JSON.stringify(rows);

describe("a kind's rows", () => {
  it("reads a form's publish as Form and Questions, its words as the body", () => {
    const rows = kindRows("form.publish", { itemId: "itm_1", title: "Spring LAN signup", rev: 4, questions: 6, content: "Name\nGame" });
    expect(rows).toEqual({ fields: [{ label: "Form", value: "Spring LAN signup" }, { label: "Questions", value: "6" }], body: "Name\nGame" });
    expect(noise(rows)).not.toContain("itm_1");
  });

  it("reads a Google share as Person and Access, and says it tells them by mail only when it does", () => {
    const share = { account: "landon@x", fileId: "1AbC", name: "Budget.xlsx", email: "dana@purdue.edu", role: "writer", notify: true };
    expect(kindRows("share.google", share)!.fields).toEqual([
      { label: "Person", value: "dana@purdue.edu" },
      { label: "Access", value: "Can edit" },
      { label: "Account", value: "landon@x" },
      { label: "Notice", value: "Tells them by mail" },
    ]);
    expect(kindRows("share.google", { ...share, role: "reader", notify: false })!.fields.map((f) => f.value)).toEqual(["dana@purdue.edu", "Can view", "landon@x"]);
    expect(noise(kindRows("share.google", share))).not.toContain("1AbC");
  });

  it("reads a Frame.io comment as File, At with its span, its marks in words and what Frame.io draws otherwise, the comment as the body", () => {
    const shapes = [{ tool: "rect" }, { tool: "rect" }, { tool: "ellipse" }];
    const rows = kindRows("frameio.post", { what: "comment", account: "acc", fileId: "f1", fileName: "trailer v3.mp4", text: "Cut here", clock: "0:42", pin: { x: 0.3, y: 0.6 }, shapes, height: 1080, itemId: "i", noteId: "n", durationFrames: 48 });
    expect(rows).toEqual({
      fields: [
        { label: "File", value: "trailer v3.mp4" },
        { label: "At", value: "0:42, for 48 frames" },
        { label: "Marks", value: "A pin, 2 boxes and an oval" },
        { label: "Goes as", value: "An oval as its box" },
      ],
      body: "Cut here",
    });
    expect(noise(rows)).not.toMatch(/"x"|f1|1080/);
    // No span, no marks: At alone, no Marks row.
    expect(kindRows("frameio.post", { what: "comment", fileName: "a.mp4", text: "Hi", clock: "0:01" })!.fields.map((f) => f.label)).toEqual(["File", "At"]);
  });

  it("reads a computer act as App, Window, URL and On, and nothing the title or Send already says", () => {
    const act = {
      tool: "computer",
      args: { action: "left_click", element: 14, app: "Chromium", url: "https://arena.example/book" },
      app: { name: "Chromium", bundleId: null },
      window: "Arena booking",
      why: "screen",
      label: "Submit booking",
      title: "Submit booking in Chromium",
      read: { step: 0, why: "send", label: "Submit booking", on: "button “Submit booking”" },
      picture: null,
      mark: "m",
      targets: [],
    };
    const rows = kindRows("computer.act", act)!;
    expect(rows.fields).toEqual([
      { label: "App", value: "Chromium" },
      { label: "Window", value: "Arena booking" },
      { label: "URL", value: "https://arena.example/book" },
      { label: "On", value: "button “Submit booking”" },
    ]);
    expect(noise(rows)).not.toMatch(/left_click|Element|14|Submit booking in/);
  });

  it("reads a Frame.io version as On top of, File, Size in MB and From, with no path or id", () => {
    const rows = kindRows("frameio.post", { what: "version", account: "acc", onto: "stk_9", ontoName: "Trailer", from: "trailer v4.mp4", path: "/Users/l/Library/Application Support/TempCode/held/x.mp4", name: "trailer v4.mp4", size: 734003200 });
    expect(rows!.fields).toEqual([
      { label: "On top of", value: "Trailer" },
      { label: "File", value: "trailer v4.mp4" },
      { label: "Size", value: "700 MB" },
      { label: "From", value: "trailer v4.mp4" },
    ]);
    expect(noise(rows)).not.toMatch(/stk_9|\/Users/);
    expect(megabytes(1.5 * 1024 * 1024)).toBe("1.5 MB");
  });

  it("reads a Teams post as In, the post as the body however short", () => {
    expect(kindRows("teams.post", { chat: "Esports staff", text: "Spring LAN is set" })).toEqual({ fields: [{ label: "In", value: "Esports staff" }], body: "Spring LAN is set" });
  });

  it("leaves every other kind to the generic reader", () => {
    expect(kindRows("addon.call", { arguments: {} })).toBeNull();
  });
});
