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
      { label: "Details", value: "Bring the deck (https://x.example/deck)" },
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

  it("draws its own view, with no host id and no JSON", () => {
    expect(officeActs["office.calendar.op"].chunk).not.toBeNull();
    const { container } = render(<View item={{ kind: "office.calendar.op", payload: invite } as never} env="mac" />);
    const labels = [...container.querySelectorAll("dt")].map((d) => d.textContent);
    expect(labels).toEqual(["Event", "When", "Where", "Invites", "Details"]);
    expect(container.textContent).not.toContain("env_mac");
    expect(container.textContent).not.toContain("{");
  });
});
