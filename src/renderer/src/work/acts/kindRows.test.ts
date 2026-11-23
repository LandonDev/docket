/** The generic view's own rows for the kinds without a view: what goes in his words, never an id, a revision, a path or JSON. */
import { describe, expect, it } from "vitest";
import { exactQuote, kindHeading, kindRows, megabytes } from "./kindRows";

const noise = (rows: ReturnType<typeof kindRows>) => JSON.stringify(rows);

describe("a kind's rows", () => {
  it("reads a form's publish as Questions, its words as the body, the form's name left to the heading", () => {
    const rows = kindRows("form.publish", { itemId: "itm_1", title: "Spring LAN signup", rev: 4, questions: 6, content: "Name\nGame" });
    expect(rows).toEqual({ fields: [{ label: "Questions", value: "6" }], body: "Name\nGame" });
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

  it("reads a Frame.io comment's marks where they land, how big and in what colour, never as a count", () => {
    const shapes = [
      { tool: "rect", color: "#ff3b30", width: 0.004, x: 0.1, y: 0.2, w: 0.3, h: 0.15 },
      { tool: "ellipse", color: "#007aff", width: 0.004, cx: 0.5, cy: 0.5, rx: 0.1, ry: 0.05 },
      { tool: "arrow", color: "#ffffff", width: 0.004, x1: 0.1, y1: 0.1, x2: 0.6, y2: 0.4 },
    ];
    const rows = kindRows("frameio.post", { what: "comment", account: "acc", fileId: "f1", fileName: "trailer v3.mp4", text: "Cut here", clock: "0:42", pin: { x: 0.31, y: 0.62 }, shapes, height: 1080, itemId: "i", noteId: "n", durationFrames: 48 });
    expect(rows).toEqual({
      fields: [
        { label: "File", value: "trailer v3.mp4" },
        { label: "At", value: "0:42, for 48 frames" },
        { label: "Pin", value: "at 31% across, 62% down" },
        { label: "Mark", value: "A box at 10% across, 20% down, 30% wide and 15% high, red, 4 px thick" },
        { label: "Mark", value: "An oval centred 50% across, 50% down, 20% wide and 10% high, blue, 4 px thick" },
        { label: "Mark", value: "An arrow from 10% across, 10% down to 60% across, 40% down, white, 4 px thick" },
        { label: "Goes as", value: "An oval as its box" },
      ],
      body: "Cut here",
    });
    // Two posts whose pins differ read differently.
    const at = (x: number, y: number) => kindRows("frameio.post", { what: "comment", fileName: "a.mp4", text: "Hi", clock: "0:01", pin: { x, y } })!.fields;
    expect(at(0.1, 0.1)).not.toEqual(at(0.9, 0.9));
    expect(noise(rows)).not.toMatch(/f1|1080|#ff3b30/);
    // No span, no marks: At alone.
    expect(kindRows("frameio.post", { what: "comment", fileName: "a.mp4", text: "Hi", clock: "0:01" })!.fields.map((f) => f.label)).toEqual(["File", "At"]);
  });

  it("reads a computer act as App, Window, URL and On, then its step, and nothing the title or Send already says", () => {
    const act = {
      tool: "computer_act",
      args: { action: "left_click", element: 14, app: "Chromium", url: "https://arena.example/book" },
      app: { name: "Chromium", bundleId: null },
      window: "Arena booking",
      why: "screen",
      label: "Submit booking",
      title: "Submit booking in Chromium",
      read: { step: 0, why: "send", label: "Submit booking", on: "button “Submit booking”" },
      picture: null,
      mark: "m",
      targets: [{ step: 0, param: "element", sig: "button:Submit booking < form:Booking", ordinal: 0, count: 1 }],
    };
    const rows = kindRows("computer.act", act)!;
    expect(rows.fields).toEqual([
      { label: "App", value: "Chromium" },
      { label: "Window", value: "Arena booking" },
      { label: "URL", value: "https://arena.example/book" },
      { label: "On", value: "button “Submit booking”" },
      { label: "Clicks", value: 'button "Submit booking"' },
    ]);
    expect(noise(rows)).not.toMatch(/left_click|Element|14|Submit booking in/);
  });

  it("reads a batch as every step in order, each typed text whole however long", () => {
    const long = `Hi Dana, ${"the ballroom is booked for April 10 and the caterer confirmed. ".repeat(4)}See you there.`;
    const actions = [
      { action: "left_click", element: 3 },
      { action: "type", text: long },
      { action: "key", text: "cmd+return" },
      { action: "screenshot" },
      { action: "left_click", coordinate: [500, 300] },
    ];
    const batch = {
      tool: "computer_batch",
      args: { actions },
      app: { name: "Mail", bundleId: null },
      window: "New Message",
      targets: [{ step: 0, param: "element", sig: "textbox:Message < window:New Message", ordinal: 0, count: 1 }],
      read: { step: 4, why: "send", label: "Send", on: "button “Send”" },
    };
    const steps = kindRows("computer.act", batch)!.fields.slice(3);
    expect(steps).toEqual([
      { label: "Clicks", value: 'textbox "Message"' },
      // The click put the focus on Message: the text and the key go there.
      { label: "Types", value: `into textbox "Message": ${long}` },
      { label: "Presses", value: 'cmd+return, in textbox "Message"' },
      { label: "Clicks", value: "the point 500,300" },
    ]);
    // Two messages that differ only in their tail never read the same.
    const other = { ...batch, args: { actions: [actions[0], { action: "type", text: `${long} PS: wire the deposit to 000-111` }] } };
    expect(kindRows("computer.act", other)!.fields).not.toEqual(kindRows("computer.act", batch)!.fields);
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

describe("where a computer act's typing goes", () => {
  const typing = (steps: unknown[], targets: unknown[]) => kindRows("computer.act", { args: { actions: steps }, app: { name: "Mail" }, window: "New Message", targets })!.fields.slice(2);

  it("names the field a typed text, a paste or a key goes to, so Bcc and Body never read the same", () => {
    const bcc = typing([{ action: "type", element: 7, text: "dana@purdue.edu" }, { action: "left_click", element: 9 }], [
      { step: 0, param: "element", sig: "textbox:Bcc < window:New Message" },
      { step: 1, param: "element", sig: "button:Send" },
    ]);
    const body = typing([{ action: "type", element: 8, text: "dana@purdue.edu" }, { action: "left_click", element: 9 }], [
      { step: 0, param: "element", sig: "textbox:Body < window:New Message" },
      { step: 1, param: "element", sig: "button:Send" },
    ]);
    expect(bcc[0]).toEqual({ label: "Types", value: 'into textbox "Bcc": dana@purdue.edu' });
    expect(body[0]).toEqual({ label: "Types", value: 'into textbox "Body": dana@purdue.edu' });
    expect(bcc).not.toEqual(body);
  });

  it("sends a step with no target of its own to the focus the host bound, and says the focus once a Tab moves it", () => {
    const rows = typing(
      [
        { action: "paste", text: "Hello" },
        { action: "key", text: "tab" },
        { action: "type", text: "Dana" },
      ],
      [{ step: 0, param: "focus", sig: "textbox:Subject < window:New Message" }],
    );
    expect(rows).toEqual([
      { label: "Pastes", value: 'into textbox "Subject": Hello' },
      { label: "Presses", value: 'tab, in textbox "Subject"' },
      { label: "Types", value: "into the focus: Dana" },
    ]);
  });

  it("says what a selection finds, in which field, and whether it selects it or puts the caret beside it", () => {
    // In "Pay $100": select Pay then paste OK sends "OK $100"; the caret after Pay then paste OK sends "PayOK $100".
    const held = (place?: string) =>
      typing(
        [
          { action: "select_text", named: "Message", text: "Pay", ...(place ? { place } : {}) },
          { action: "paste", text: "OK" },
          { action: "left_click", element: 9 },
        ],
        [
          { step: 0, param: "point", sig: "text area:Message < window:New Message" },
          { step: 2, param: "element", sig: "button:Send" },
        ],
      );
    expect(held()).toEqual([
      { label: "Selects", value: 'the first "Pay" in text area "Message"' },
      { label: "Pastes", value: 'into text area "Message": OK' },
      { label: "Clicks", value: 'button "Send"' },
    ]);
    expect(held("after")[0]).toEqual({ label: "Puts the caret", value: 'after the first "Pay" in text area "Message"' });
    expect(held("before")[0]).toEqual({ label: "Puts the caret", value: 'before the first "Pay" in text area "Message"' });
    expect(held("select")).toEqual(held());
    expect(held("after")).not.toEqual(held());
    const one = (step: Record<string, unknown>) => typing([step], [{ step: 0, param: "element", sig: "text area:Message < window:New Message" }])[0];
    expect(one({ action: "select_text", element: 4, text: "Pay", prefix: "Total: ", suffix: " now" })).toEqual({
      label: "Selects",
      value: 'the first "Pay" right after "Total: " and right before " now" in text area "Message"',
    });
    expect(one({ action: "select_text", element: 4, range: [4, 9], place: "after" })).toEqual({ label: "Puts the caret", value: 'after characters 4 to 9 in text area "Message"' });
  });

  it("shows every prefix and suffix given, spaces alone included, quoted with what cannot be seen escaped", () => {
    const one = (step: Record<string, unknown>) => typing([step], [{ step: 0, param: "element", sig: "text area:Message < window:New Message" }])[0]!.value;
    const caret = (more: Record<string, unknown>) => one({ action: "select_text", element: 4, text: "Pay", place: "after", ...more });
    // "Pay" with a space before it is another occurrence than the first "Pay": the rows must differ
    expect(caret({})).toBe('after the first "Pay" in text area "Message"');
    expect(caret({ prefix: " " })).toBe('after the first "Pay" right after " " in text area "Message"');
    expect(caret({ suffix: "  " })).toBe('after the first "Pay" right before "  " in text area "Message"');
    expect(caret({ prefix: "\t", suffix: "\n" })).toBe('after the first "Pay" right after "\\t" and right before "\\n" in text area "Message"');
    // a no-break space looks like a space and is not one
    expect(caret({ prefix: "\u00a0" })).toBe('after the first "Pay" right after "\\u00a0" in text area "Message"');
    expect(caret({ prefix: "\u00a0" })).not.toBe(caret({ prefix: " " }));
    expect(caret({ prefix: 'say "' })).toBe('after the first "Pay" right after "say \\"" in text area "Message"');
  });

  it("escapes every character that cannot be seen by its Unicode class, not by a list", () => {
    expect(exactQuote("a\u2063b")).toBe('"a\\u2063b"');
    expect(exactQuote("co\u00adop")).toBe('"co\\u00adop"');
    expect(exactQuote("\u200e\u202e\u2066")).toBe('"\\u200e\\u202e\\u2066"');
    expect(exactQuote("\u0085\u007f")).toBe('"\\u0085\\u007f"');
    expect(exactQuote("\u2029\u3000\u205f")).toBe('"\\u2029\\u3000\\u205f"');
    expect(exactQuote("tag\u{e0041}")).toBe('"tag\\u{e0041}"');
    // what is seen is left as it is: a plain space, letters, an emoji
    expect(exactQuote("Pay $100 ✓ 🙂")).toBe('"Pay $100 ✓ 🙂"');
    expect(exactQuote("a\nb\t")).toBe('"a\\nb\\t"');
  });

  it("reads a bound element from the host's tuples, a name holding \" < \" whole, and from an older act's text the same", () => {
    const click = (sig: string) => typing([{ action: "left_click", element: 3 }], [{ step: 0, param: "element", sig }])[0];
    expect(click(JSON.stringify([["button", "Pay < group:Alice"], ["group", "Bob"], ["window", "Pay"]]))).toEqual({ label: "Clicks", value: 'button "Pay < group:Alice"' });
    expect(click(JSON.stringify([["toolbar", ""], ["window", "Pay"]]))).toEqual({ label: "Clicks", value: "toolbar" });
    // the same words as before for a held act stored in the older form
    expect(click("button:Send < toolbar: < window:New Message")).toEqual({ label: "Clicks", value: 'button "Send"' });
    expect(click(JSON.stringify([["button", "Send"], ["toolbar", ""], ["window", "New Message"]]))).toEqual(click("button:Send < toolbar: < window:New Message"));
  });

  it("keeps the field in every row of a long batch, whatever the title cuts", () => {
    const fields = ["To", "Cc", "Subject", "Message"];
    const steps = fields.flatMap((name, i) => [
      { action: "select_text", named: name, text: "x" },
      { action: "paste", text: `line ${i}` },
    ]);
    const targets = fields.map((name, i) => ({ step: i * 2, param: "point", sig: `text area:${name} < window:New Message` }));
    const rows = typing(steps, targets);
    expect(rows).toHaveLength(8);
    rows.forEach((row, i) => expect(row.value).toContain(`text area "${fields[Math.floor(i / 2)]}"`));
  });
});

describe("a Frame.io drawn line", () => {
  it("draws every point of its path in order, exactly, with its thickness", () => {
    const pen = (mid: [number, number]) =>
      kindRows("frameio.post", { what: "comment", fileName: "a.mp4", text: "Here", clock: "0:01", height: 1080, shapes: [{ tool: "pen", color: "#ff3b30", width: 0.003, points: [[0.1, 0.1], mid, [0.5, 0.5]] }] })!.fields.find((f) => f.label === "Mark")!.value;
    expect(pen([0.2, 0.3])).toBe("A drawn line through 10% across, 10% down; 20% across, 30% down; 50% across, 50% down, red, 3 px thick");
    // Same ends, another middle: another path, another row.
    expect(pen([0.155, 0.3])).not.toBe(pen([0.2, 0.3]));
    expect(pen([0.155, 0.3])).toContain("15.5% across");
  });
});

describe("a kind's detail heading", () => {
  it("names the form, the shared file, or the Teams act alone, so the rows say the rest once", () => {
    expect(kindHeading("form.publish", { title: "Spring LAN signup" }, false)).toBe("Publish Spring LAN signup");
    expect(kindHeading("form.publish", { title: "Spring LAN signup" }, true)).toBe("Published Spring LAN signup");
    expect(kindHeading("share.google", { name: "Budget.xlsx", email: "dana@purdue.edu", role: "writer" }, false)).toBe("Share Budget.xlsx");
    expect(kindHeading("share.google", { name: "Budget.xlsx" }, true)).toBe("Shared Budget.xlsx");
    expect(kindHeading("teams.post", { chat: "Esports staff", text: "Hi" }, false)).toBe("Post in Teams");
    expect(kindHeading("teams.post", { chat: "Esports staff", text: "Hi" }, true)).toBe("Posted in Teams");
    expect(kindHeading("mail.send", {}, false)).toBeNull();
  });
});

describe("an agent's change to a shared file, as he approves it", () => {
  it("reads a Word replace in full, the app it goes into, and no key, host or count", () => {
    const p = { host: "env_mac", app: "word", key: "/Users/l/Library/CloudStorage/OneDrive-Purdue/Brief.docx", name: "Brief.docx", edit: { find: "We ship in March", replace: "We ship in May, after the review" }, places: 1, base: "abc" };
    expect(kindRows("office.edit", p)).toEqual({
      fields: [
        { label: "In", value: "Word" },
        { label: "Replace", value: "We ship in March" },
        { label: "With", value: "We ship in May, after the review" },
      ],
      body: null,
    });
    expect(noise(kindRows("office.edit", p))).not.toMatch(/OneDrive|env_mac|abc/);
    expect(kindRows("office.edit", { ...p, edit: { find: "draft", replace: "" } })!.fields.at(-1)).toEqual({ label: "Take out", value: "draft" });
  });

  it("reads an insert as where it goes, its text the body", () => {
    expect(kindRows("office.edit", { app: "word", name: "Brief.docx", edit: { insert: "A last line.", at: "end" } })).toEqual({ fields: [{ label: "In", value: "Word" }, { label: "Adds at", value: "The end" }], body: "A last line." });
  });

  it("reads each of a deck's changes in one grammar, a box by its slide, a replace-all by its boxes, the account after the app", () => {
    const p = { app: "slides", account: "landon@purdue.edu", fileId: "1AbC", name: "Pitch", revisionId: "r9", edits: [{ find: "2025", replace: "2026", boxes: 3 }, { shape: "t4", text: "Hi", slide: 3, was: "Hello" }, { shape: "t5", text: "", slide: 4, was: "Old" }] };
    expect(kindRows("google.edit", p)!.fields).toEqual([
      { label: "In", value: "Google Slides" },
      { label: "Account", value: "landon@purdue.edu" },
      { label: "Where", value: "3 boxes" },
      { label: "Replace", value: "2025" },
      { label: "With", value: "2026" },
      { label: "Where", value: "Slide 3", gap: true },
      { label: "Replace", value: "Hello" },
      { label: "With", value: "Hi" },
      { label: "Where", value: "Slide 4", gap: true },
      { label: "Take out", value: "Old" },
    ]);
    expect(noise(kindRows("google.edit", p))).not.toMatch(/1AbC|r9|t4/);
  });

  it("says how many places a Word replace reaches, the VM when it goes there, and spaces as spaces", () => {
    const p = { app: "word", vm: true, name: "Brief.docx", places: 4, edit: { find: "Q1", replace: " " } };
    expect(kindRows("office.edit", p)!.fields).toEqual([
      { label: "In", value: "Word in the Windows VM" },
      { label: "Where", value: "4 places" },
      { label: "Replace", value: "Q1" },
      { label: "With", value: '" "' },
    ]);
  });

  it("names a Doc's paragraph as Where, and quotes words that differ only in their spaces", () => {
    const p = { app: "doc", account: "a@b.edu", name: "Brief", edits: [{ find: "March", replace: "May", within: "We ship in March." }, { find: "a  b", replace: "a b" }] };
    expect(kindRows("google.edit", p)!.fields.slice(2)).toEqual([
      { label: "Where", value: "We ship in March." },
      { label: "Replace", value: "March" },
      { label: "With", value: "May" },
      { label: "Replace", value: '"a  b"', gap: true },
      { label: "With", value: '"a b"' },
    ]);
  });

  it("heads the detail with the file, in the past once made", () => {
    expect(kindHeading("office.edit", { name: "Brief.docx" }, false)).toBe("Change Brief.docx");
    expect(kindHeading("google.edit", { name: "Pitch" }, true)).toBe("Changed Pitch");
  });
});
