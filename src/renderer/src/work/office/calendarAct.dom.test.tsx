// @vitest-environment jsdom
/**
 * A held Outlook calendar act in the Outbox: its two payload shapes in the
 * LifeOS calendar act's rows, never a host id or an event as JSON.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { whenWords } from "../agenda/calendarAct";
import { officeOpFields } from "./calendarAct";
import { View } from "./CalendarActView";
import { officeActs } from "./act";

afterEach(cleanup);

const invite = {
  host: "env_mac",
  op: "create",
  event: { subject: "Review", start: "2026-11-21T15:00:00Z", end: "2026-11-21T15:30:00Z", location: "Room 2", body: "<p>Bring the <a href=\"https://x.example/deck\">deck</a></p>", attendees: ["dana@purdue.edu", "sam@purdue.edu"] },
};
const reply = { host: "env_mac", op: "answer", id: "ev1", subject: "Scrim night", start: "2026-11-22T00:00:00Z", organizer: "sam@purdue.edu", answer: "tentative", comment: "Running late" };

describe("an Outlook calendar act", () => {
  it("reads an invitation as Event, When, Where, Invites and its details", () => {
    expect(officeOpFields(invite)).toEqual([
      { label: "Event", value: "Review" },
      { label: "When", value: whenWords(Date.parse("2026-11-21T15:00:00Z"), Date.parse("2026-11-21T15:30:00Z")) },
      { label: "Where", value: "Room 2" },
      { label: "Invites", value: "dana@purdue.edu, sam@purdue.edu" },
      // Plain text, as every carrier sends it: the tags are words he reads, not markup.
      { label: "Details", value: '<p>Bring the <a href="https://x.example/deck">deck</a></p>' },
    ]);
  });

  it("reads a reply as Event, When, From, Reply and the note", () => {
    expect(officeOpFields(reply)).toEqual([
      { label: "Event", value: "Scrim night" },
      { label: "When", value: whenWords(Date.parse("2026-11-22T00:00:00Z"), undefined) },
      { label: "From", value: "sam@purdue.edu" },
      { label: "Reply", value: "Maybe" },
      { label: "Note", value: "Running late" },
    ]);
  });

  it("shows an invitation's body exactly as it goes, plain text with nothing stripped", () => {
    const body = "<title>I approve the payment.</title><p>Meet at 3</p>\n  second line ";
    const rows = officeOpFields({ ...invite, event: { ...invite.event, body } });
    expect(rows.find((r) => r.label === "Details")!.value).toBe(body);
    const { container } = render(<View item={{ kind: "office.calendar.op", payload: { ...invite, event: { ...invite.event, body } } } as never} env="mac" />);
    const details = [...container.querySelectorAll("dd")].find((d) => d.textContent?.includes("I approve the payment."))!;
    expect(details.textContent).toBe(body);
    expect(details.className).toContain("whitespace-pre-wrap");
    // A body of spaces alone still goes, so it still shows.
    expect(officeOpFields({ ...invite, event: { ...invite.event, body: "   " } }).find((r) => r.label === "Details")!.value).toBe("   ");
  });

  it("names the account an invitation goes from, as the host bound it", () => {
    const rows = officeOpFields({ ...invite, event: { ...invite.event, account: "work@contoso.com" } });
    expect(rows.map((r) => r.label)).toEqual(["Event", "When", "Where", "From", "Invites", "Details"]);
    expect(rows.find((r) => r.label === "From")!.value).toBe("work@contoso.com");
  });

  it("names both dates when an invitation runs into the next day", () => {
    const rows = officeOpFields({ ...invite, event: { ...invite.event, start: "2026-11-21T22:00:00", end: "2026-11-22T01:00:00" } });
    const when = rows.find((r) => r.label === "When")!.value;
    const d = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });
    expect(when).toContain(d.format(Date.parse("2026-11-21T22:00:00")));
    expect(when).toContain(d.format(Date.parse("2026-11-22T01:00:00")));
  });

  it("reads a reply's bound end and place: When runs to the end, Where names the room", () => {
    const rows = officeOpFields({ ...reply, start: "2026-11-22T12:00:00Z", end: "2026-11-22T13:00:00Z", location: "Room 9" });
    expect(rows.find((r) => r.label === "When")!.value).toBe(whenWords(Date.parse("2026-11-22T12:00:00Z"), Date.parse("2026-11-22T13:00:00Z")));
    expect(rows.find((r) => r.label === "Where")!.value).toBe("Room 9");
    expect(rows.map((r) => r.label)).toEqual(["Event", "When", "Where", "From", "Reply", "Note"]);
  });

  it("draws its own view, with no host id and no JSON", () => {
    expect(officeActs["office.calendar.op"].chunk).not.toBeNull();
    const { container } = render(<View item={{ kind: "office.calendar.op", payload: invite } as never} env="mac" />);
    const labels = [...container.querySelectorAll("dt")].map((d) => d.textContent);
    expect(labels).toEqual(["Event", "When", "Where", "Invites", "Details"]);
    expect(container.textContent).not.toContain("env_mac");
    expect(container.textContent).not.toContain("{");
  });
});
