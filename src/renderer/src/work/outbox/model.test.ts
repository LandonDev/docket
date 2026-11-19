import { describe, expect, it } from "vitest";
import { applyEdits, awayLine, awaySections, byWorkspace, dayOf, decidedWords, grantFor, grantLine, htmlWords, parseAddresses, pastOf, payloadView } from "./model";

const MAIL = {
  id: "o1",
  status: "draft",
  message: {
    kind: "mail",
    accountId: "acc-purdue",
    from: { name: "Landon", address: "landon@purdue.edu" },
    to: [{ name: "Dana Lee", address: "dlee@purdue.edu" }],
    cc: [],
    bcc: [],
    subject: "Nationals budget, first draft",
    html: "<p>old</p>",
    text: "Dana,\n\nThe first draft is in the shared sheet.\n\nLandon",
  },
};
const CALL = { addonId: "a1", addon: "Slack", tool: "post_message", words: "Post message", arguments: { channel: "staff", text: "Spring LAN is set" }, specDigest: "d1" };

describe("payloadView", () => {
  it("draws a LifeOS mail as its fields and its body, leaving the host's bookkeeping out", () => {
    const { fields, body } = payloadView(MAIL);
    expect(fields.map((f) => [f.label, f.value])).toEqual([
      ["From", "Landon <landon@purdue.edu>"],
      ["To", "Dana Lee <dlee@purdue.edu>"],
      ["Subject", "Nationals budget, first draft"],
    ]);
    // The html is what goes, so the body reads from it; an edit still goes to the text and rebuilds the html.
    expect(body).toEqual({ path: ["message", "text"], text: "old" });
  });

  it("shows an html-only mail's words, links and images, and does not offer them for editing", () => {
    const office = { host: "env_mac", to: ["dlee@purdue.edu"], cc: [], bcc: [], subject: "Budget", html: '<p>See <a href="https://evil.example/x">the sheet</a></p><img src="https://t.example/p.gif">' };
    const { fields, body } = payloadView(office);
    // The holding host's id is bookkeeping: never a field he approves.
    expect(fields.map((f) => f.label)).toEqual(["To", "Subject"]);
    expect(body).toEqual({ path: ["html"], text: "See the sheet (https://evil.example/x)\n\n[image: https://t.example/p.gif]", readOnly: true });
    expect(applyEdits(office, new Map([["html", "changed"]])).payload).toEqual(office);
  });

  it("labels a url URL", () => {
    expect(payloadView({ url: "https://example.com" }).fields.map((f) => f.label)).toEqual(["URL"]);
  });

  it("shows every key of an add-on call's arguments, the ones the host keeps for itself included", () => {
    const { fields } = payloadView({ ...CALL, arguments: { id: "C024BE91L", html: "<b>hi</b>", status: "public", text: "hello" } });
    expect(fields.map((f) => [f.label, f.value])).toEqual([
      ["Id", "C024BE91L"],
      ["Html", "<b>hi</b>"],
      ["Status", "public"],
      ["Text", "hello"],
    ]);
    const nested = payloadView({ ...CALL, arguments: { options: { name: "standard", publish: true }, to: { address: "a@b.c", bcc: "x@y.z" }, note: null, tags: [] } });
    expect(nested.fields.map((f) => [f.label, f.value])).toEqual([
      ["Options", '{"name":"standard","publish":true}'],
      ["To", '{"address":"a@b.c","bcc":"x@y.z"}'],
      ["Note", "null"],
      ["Tags", "[]"],
    ]);
    expect(payloadView({ ...CALL, arguments: { destination: "", text: "hi" } }).fields.map((f) => [f.label, f.value])).toEqual([
      ["Destination", '""'],
      ["Text", "hi"],
    ]);
    const blank = payloadView({ ...CALL, arguments: { body: "\n", text: " ".repeat(81) } });
    expect(blank.body).toBeNull();
    expect(blank.fields.map((f) => [f.label, f.value])).toEqual([
      ["Body", '"\\n"'],
      ["Text", JSON.stringify(" ".repeat(81))],
    ]);
  });
});

describe("htmlWords", () => {
  it("keeps every link's target and image's source, and drops what does not show", () => {
    expect(htmlWords('<style>p{}</style><p>Hi&nbsp;Dana,</p><p>Go <a href="https://a.example">here</a> or <a href="mailto:x@y.z">x@y.z</a>.<br>Thanks</p><script>x()</script>')).toBe(
      "Hi Dana,\n\nGo here (https://a.example) or x@y.z.\nThanks",
    );
    expect(htmlWords('<a href="https://x.example"><img src="https://t.example/p.gif"></a>')).toBe("[image: https://t.example/p.gif] (https://x.example)");
    expect(htmlWords('<table background="https://e.test/private.png"><tr><td style="background-image: url(\'https://e.test/b.png\')">Hi</td></tr></table>')).toBe(
      "Hi\n[background image: https://e.test/private.png]\n[background image: https://e.test/b.png]",
    );
    expect(htmlWords('<p style="background-image:u&#114;l(https://e.test/p)">Hi</p>')).toBe("Hi\n[background image: https://e.test/p]");
    expect(htmlWords('<p style="background-image:u\\72l(https://e.test/q)">Hi</p>')).toBe("Hi\n[background image: https://e.test/q]");
    expect(htmlWords('<p style="background:url&lpar;https://e.test/r&rpar;">Hi</p>')).toBe("Hi\n[background image: https://e.test/r]");
    expect(htmlWords('<p style="background:u&#114l(https://e.test/s)">Hi</p>')).toBe("Hi\n[background image: https://e.test/s]");
    expect(htmlWords('<ul><li>one</li><li>two &amp; three</li></ul><img alt="logo" src=\'/l.png\'>')).toBe("- one\n- two & three\n\n[image logo: /l.png]");
  });

  it("opens an add-on call's arguments, not its wrapper", () => {
    const { fields, body } = payloadView(CALL);
    expect(fields.map((f) => [f.label, f.value, f.path.join(".")])).toEqual([
      ["In", "staff", "arguments.channel"],
      ["Text", "Spring LAN is set", "arguments.text"],
    ]);
    expect(body).toBeNull();
  });
});

describe("applyEdits", () => {
  it("writes the edited text and a fresh html beside it, so what goes is what he read", () => {
    const { payload, error } = applyEdits(MAIL, new Map([["message.text", "Dana,\n\nNew draft <today>."], ["message.to", "Dana Lee <dlee@purdue.edu>, sam@purdue.edu"]]));
    expect(error).toBeNull();
    const m = (payload as typeof MAIL).message;
    expect(m.text).toBe("Dana,\n\nNew draft <today>.");
    expect(m.html).toBe("<p>Dana,</p><p>New draft &lt;today&gt;.</p>");
    expect(m.to).toEqual([{ name: "Dana Lee", address: "dlee@purdue.edu" }, { address: "sam@purdue.edu" }]);
    expect(m.accountId).toBe("acc-purdue");
  });

  it("refuses a recipient that is not an address, and changes nothing", () => {
    expect(applyEdits(MAIL, new Map([["message.to", "Dana Lee"]]))).toEqual({ payload: MAIL, error: "To: one of these is not an address" });
    expect(parseAddresses("a@b.c; \"Sam\" <s@b.c>")).toEqual([{ address: "a@b.c" }, { name: "Sam", address: "s@b.c" }]);
  });
});

describe("grantFor", () => {
  it("fixes a mail's account and every recipient, and names them", () => {
    expect(grantFor({ kind: "mail.send", payload: MAIL })).toEqual({ matcher: { accountId: "acc-purdue", recipients: ["dlee@purdue.edu"] }, label: "Mail to Dana Lee" });
  });
  it("fixes an add-on call's server and tool", () => {
    expect(grantFor({ kind: "addon.call", payload: CALL })).toEqual({ matcher: { addonId: "a1", tool: "post_message" }, label: "Post message with Slack" });
  });
  it("offers none for a computer act, or a kind whose pillar has not said how", () => {
    expect(grantFor({ kind: "computer.act", payload: { tool: "click" } })).toBeNull();
    expect(grantFor({ kind: "teams.post", payload: { to: "x" } })).toBeNull();
  });
});

describe("the lists", () => {
  it("groups held items by workspace and host, Work Chats as one", () => {
    const at = (environmentId: string, workspaceId: string | null) => ({ environmentId, workspaceId, sector: workspaceId ? "purdue" : null });
    const groups = byWorkspace([at("box", "ws1"), at("box", "~work"), at("mac", "ws1"), at("box", "ws1"), at("box", null)]);
    expect(groups.map((g) => [g.key, g.items.length])).toEqual([
      ["box:ws1", 2],
      ["box:~work", 2],
      ["mac:ws1", 1],
    ]);
  });
  it("says who sent it, and when", () => {
    expect(decidedWords({ decidedBy: "owner", verb: "Send" })).toBe("Sent by you");
    expect(decidedWords({ decidedBy: "owner:remote", verb: "Post" })).toBe("Posted from another device");
    expect(decidedWords({ decidedBy: "grant:g1", verb: "Send" }, "Mail to Dana Lee")).toBe("Sent by the grant Mail to Dana Lee");
    expect(pastOf("Make link")).toBe("Made link");
    expect(grantLine("mail.send", Date.now())).toBe("Made today from a held mail");
    const now = new Date(2026, 10, 19, 12).getTime();
    expect([dayOf(now - 3_600_000, now), dayOf(now - 86_400_000, now), dayOf(now - 3 * 86_400_000, now)]).toEqual(["Today", "Yesterday", "Earlier"]);
  });
});

describe("the return from Away", () => {
  it("lists held, failed, decided and written, in that order, leaving out what is empty", () => {
    expect(awaySections({ held: 2, failed: 1, decided: 3, written: 4 })).toEqual(["held", "failed", "decided", "written"]);
    expect(awaySections({ held: 0, failed: 0, decided: 1, written: 2 })).toEqual(["decided", "written"]);
  });
  it("says it in one toast line, or nothing when nothing happened", () => {
    expect(awayLine({ held: 7, failed: 0, decided: 4, written: 3 })).toBe("Held 7, decided 4 without you");
    expect(awayLine({ held: 31, failed: 2, decided: 6, written: 0 })).toBe("Held 31, decided 6 without you, 2 failed");
    expect(awayLine({ held: 0, failed: 0, decided: 0, written: 2 })).toBe("Wrote on 2 files while you were away");
    expect(awayLine({ held: 0, failed: 0, decided: 0, written: 0 })).toBeNull();
  });
});
