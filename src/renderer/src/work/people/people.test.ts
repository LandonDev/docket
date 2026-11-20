import { describe, expect, it } from "vitest";
import type { GuestLinkRow } from "@shared/contract-work-guests";
import { faceMap, findPeople, knownAttendees, linksFor, linkWords, pageIsQuiet, personFor, pictureOf, type DirectoryPerson, type PersonPage } from "./model";
import { mailTo, onMailto, writeMail } from "../mail/mailto";

const maya: DirectoryPerson = { _id: "p1", name: "Maya Chén", emails: ["maya@school.edu"], lastAt: 5 };
const tom: DirectoryPerson = { _id: "p2", name: "Tom Beck", emails: ["tom@school.edu", "TB@home.net"] };
const rows = [maya, tom];

describe("the People list", () => {
  it("keeps the list's order and finds by every word, in names and addresses, folded for case and accents", () => {
    expect(findPeople(rows, "")).toEqual(rows);
    expect(findPeople(rows, "maya chen")).toEqual([maya]);
    expect(findPeople(rows, "home.net")).toEqual([tom]);
    expect(findPeople(rows, "school")).toEqual([maya, tom]);
    expect(findPeople(rows, "maya tom")).toEqual([]);
  });

  it("finds a person by id or by any address of theirs", () => {
    expect(personFor(rows, "p2")).toBe(tom);
    expect(personFor(rows, "tb@HOME.net")).toBe(tom);
    expect(personFor(rows, "nobody@school.edu")).toBeUndefined();
  });

  it("draws the picture Mail holds for the first of their addresses that has one", () => {
    const faces = faceMap([{ address: "TB@home.net", url: "https://lifeos/p.png" }, { address: "x@y.z", storageId: "kg1" }, { address: "none@y.z" }], "https://lifeos/api/storage/");
    expect(pictureOf(tom.emails, faces)).toBe("https://lifeos/p.png");
    expect(faces.get("x@y.z")).toBe("https://lifeos/api/storage/kg1");
    expect(faces.has("none@y.z")).toBe(false);
    expect(pictureOf(maya.emails, faces)).toBeUndefined();
  });

  it("names an event's attendees who are the sector's people, each once, in the event's order", () => {
    expect(knownAttendees([{ address: "TOM@school.edu" }, { address: "stranger@x.y" }, { address: "maya@school.edu" }, { address: "tb@home.net" }], rows)).toEqual([tom, maya]);
    expect(knownAttendees(undefined, rows)).toEqual([]);
  });
});

describe("a person's guest links", () => {
  const link = (id: string, name: string, over: Partial<GuestLinkRow> = {}): GuestLinkRow => ({
    id,
    name,
    source: { at: "lifeos", table: "docs", id: `d-${id}` },
    title: "t",
    role: "view",
    createdAt: 1,
    expiresAt: 100,
    revokedAt: null,
    by: "owner",
    lastOpenedAt: null,
    open: 0,
    ...over,
  });

  it("keeps the live links named for them, newest first, one an item", () => {
    const links = [
      link("a", "maya chen", { createdAt: 1 }),
      link("b", "Maya  Chen", { createdAt: 3, source: { at: "lifeos", table: "docs", id: "d-a" } }),
      link("c", "Maya Chen", { revokedAt: 2 }),
      link("d", "Maya Chen", { expiresAt: 10 }),
      link("e", "Tom Beck"),
    ];
    expect(linksFor(links, "Maya Chén", 50).map((l) => l.id)).toEqual(["b"]);
    expect(linksFor(links, "", 50)).toEqual([]);
  });

  it("says what a link lets them do, and until when", () => {
    expect(linkWords("comment", new Date(2026, 11, 3).getTime())).toMatch(/^Can comment until Dec 3$/);
  });
});

describe("a quiet page", () => {
  const page: PersonPage = { person: { _id: "p1", name: "Maya", notes: "", sectors: ["purdue"], emails: [], phones: [] }, mail: [], coming: [], recent: [], tasks: [], shared: [] };
  it("is quiet with nothing live, and not with one thing", () => {
    expect(pageIsQuiet(page)).toBe(true);
    expect(pageIsQuiet({ ...page, recent: [{ _id: "e", title: "Old", startsAt: 1 }] })).toBe(false);
  });
});

describe("Write", () => {
  it("waits for a mailbox when none listens, then reaches the newest one only", async () => {
    writeMail(mailTo(["maya@school.edu"]));
    const first: unknown[] = [];
    const off = onMailto((d) => first.push(d));
    await Promise.resolve();
    expect(first).toEqual([{ to: ["maya@school.edu"], cc: [], bcc: [], subject: "", body: "" }]);
    const second: unknown[] = [];
    const off2 = onMailto((d) => second.push(d));
    writeMail(mailTo(["tom@school.edu"]));
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    off2();
    off();
  });
});
