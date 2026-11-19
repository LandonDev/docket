import { describe, expect, it } from "vitest";
import { nextToday } from "../tasks/facts";
import { eventPayload } from "./newEvent";

const form = { title: "Walk the ballroom", day: "2026-11-20", from: "09:00", to: "10:30", where: "", invite: "" };

describe("New event's act", () => {
  it("makes a create's payload from the form", () => {
    expect(eventPayload({ ...form, where: " Memorial Union ", invite: "Sam@Purdue.edu, dana@purdue.edu sam@purdue.edu" })).toEqual({
      title: "Walk the ballroom",
      startsAt: new Date("2026-11-20T09:00").getTime(),
      endsAt: new Date("2026-11-20T10:30").getTime(),
      location: "Memorial Union",
      attendees: [{ address: "sam@purdue.edu" }, { address: "dana@purdue.edu" }],
    });
  });

  it("says what is wrong instead", () => {
    expect(eventPayload({ ...form, title: " " })).toBe("Give it a name");
    expect(eventPayload({ ...form, to: "08:00" })).toBe("It must end after it starts");
    expect(eventPayload({ ...form, invite: "sam" })).toBe("sam is not an address");
  });
});

describe("the Agenda row's fact", () => {
  it("is today's next timed event, or the one still on", () => {
    const at = (h: number) => new Date(2026, 10, 19, h).getTime();
    const events = [
      { startsAt: at(9), endsAt: at(10), allDay: false },
      { startsAt: at(14), endsAt: at(15), allDay: false },
      { startsAt: at(0), allDay: true },
      { startsAt: at(16), endsAt: at(17), allDay: false, hidden: true },
    ];
    expect(nextToday(events, at(11))).toBe(at(14));
    expect(nextToday(events, at(9) + 1)).toBe(at(9));
    expect(nextToday(events, at(15) + 1)).toBeNull();
  });
});
