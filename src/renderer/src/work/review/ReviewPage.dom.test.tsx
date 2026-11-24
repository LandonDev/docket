// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DESK_NOTE, HOURS_NOTE, LEFT, NOT_KNOWN } from "@shared/work/review";
import { fixtureView, type FixtureState } from "./fixtures";
import { HeadView } from "./Head";
import { ReviewPageView, stillAway } from "./ReviewPage";

/** The page in each of its states, over the made-up week: what it says, what it leaves out, and what a press does. */

afterEach(cleanup);

const draw = (state: FixtureState, over: Partial<Parameters<typeof ReviewPageView>[0]> = {}) => {
  const { view, now } = fixtureView(state);
  const props = { view, now, gone: new Set<string>(), canOpen: () => true, onOpen: vi.fn(), onPress: vi.fn(), onRetry: vi.fn(), ...over };
  const out = render(<ReviewPageView {...props} />);
  return { ...out, props, view };
};
const section = (name: string) => screen.getByRole("heading", { name, level: 2 }).closest("section")!;
/** An element's words as read: each text node a word run, a space between runs. */
const text = (el: Element): string => {
  const runs: string[] = [];
  const walk = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node = walk.nextNode(); node; node = walk.nextNode()) if (node.textContent?.trim()) runs.push(node.textContent.trim());
  return runs.join(" ").replace(/ ,/g, ",").replace(/\s+/g, " ");
};

describe("a full week, looked at the Monday after", () => {
  it("is three sections in the order of a Friday, under one line that says when it was made, with no second title", () => {
    const { container } = draw("full");
    expect([...container.querySelectorAll("h2")].map((h) => h.textContent)).toEqual(["Hours", "Shipped", "Slipped"]);
    expect(container.querySelector("h1")).toBeNull();
    expect(text(container.querySelector("[data-review-made]")!)).toBe("Made Fri 4:00 PM");
  });

  it("lists every job in Hours, the starved one too, and says which numbers are estimates", () => {
    draw("full");
    const hours = section("Hours");
    const rows = [...hours.querySelectorAll("[data-review-job]")].map((row) => text(row));
    expect(rows.map((r) => r.split(" ")[0])).toEqual(["Cosmic", "Hypixel", "Purdue", "Ref", "Unify", "Life"]);
    // Calendar alone is a measure; anything with desk time says "about".
    expect(rows.find((r) => r.startsWith("Ref"))).toBe("Ref 6 h 30 m");
    for (const name of ["Cosmic", "Hypixel", "Purdue", "Life"]) expect(rows.find((r) => r.startsWith(name))).toContain("about ");
    // Words that hold for any week shown: the page may show this one long after.
    expect(rows.find((r) => r.startsWith("Unify"))).toBe("Unify Nothing seen about 6 h 15 m the week before");
    // The week before is said only where it says something: Purdue rose by hours, the others moved little.
    expect(rows.filter((r) => r.includes("the week before") || r.includes(" from "))).toHaveLength(2);
    expect(rows.find((r) => r.startsWith("Purdue"))).toMatch(/^Purdue about \d+ h( \d+ m)? up from about \d+ h( \d+ m)?$/);
    expect(hours.querySelector("[data-starved] [data-review-bar]")).toBeNull();
    // The closing line is the bar's key: each shape, for the eye alone, before the sentence that says what it is.
    expect(text(hours)).toContain(HOURS_NOTE);
    const key = [...hours.querySelectorAll("p")].at(-1)!;
    expect([...key.querySelectorAll("[aria-hidden]")].map((shape) => (shape.className.includes("border") ? "outlined" : "filled"))).toEqual(["filled", "outlined"]);
    // A piece of the bar, not a dot: a dot before a sentence is a bullet.
    for (const shape of key.querySelectorAll("[aria-hidden]")) expect(shape.className).toContain("h-2 w-3");
  });

  it("sets every row on one edge and one height: no border of the row component's shifts a pressable one", () => {
    draw("back", { peek: { folds: true } });
    const items = [...section("Hours").querySelectorAll('[data-slot="item"]'), ...section("Shipped").querySelectorAll('[data-slot="item"]'), ...section("Slipped").querySelectorAll("[data-review-dealt]")];
    expect(items.length).toBeGreaterThan(10);
    for (const item of items) expect(item.className).toContain("border-0");
  });

  it("draws calendar time filled and desk time outlined, on one scale", () => {
    draw("full");
    const bars = [...section("Hours").querySelectorAll<HTMLElement>("[data-review-bar]")];
    expect(bars).toHaveLength(5);
    const ref = bars[3]!;
    expect([...ref.children].map((c) => c.getAttribute("data-part"))).toEqual(["calendar"]);
    const cosmic = bars[0]!;
    expect([...cosmic.children].map((c) => c.getAttribute("data-part"))).toEqual(["calendar", "desk"]);
    expect(cosmic.querySelector<HTMLElement>('[data-part="desk"]')!.className).toContain("border");
    expect(cosmic.querySelector<HTMLElement>('[data-part="desk"]')!.className).not.toContain("bg-");
    // No part is shorter than the key's own 12px piece: shorter, it would draw as a dot or a ring.
    for (const part of section("Hours").querySelectorAll("[data-part]")) expect(part.className).toContain("min-w-3");
    // The longest job fills the scale; no bar is wider than it.
    const width = (bar: HTMLElement) => [...bar.children].reduce((n, c) => n + parseFloat((c as HTMLElement).style.width), 0);
    expect(Math.max(...bars.map(width))).toBeCloseTo(100, 0);
    expect(bars[0]!.getAttribute("aria-hidden")).toBe("true");
  });

  it("opens a job's row to its three facts, each said as what it is", () => {
    draw("full");
    const cosmic = section("Hours").querySelector('[data-review-job="cosmic"]')!;
    fireEvent.click(within(cosmic as HTMLElement).getByRole("button"));
    const facts = text(cosmic.querySelector("dl")!);
    // Each fact is its own run (`Facts`: the commas are drawn, and a line breaks only between facts).
    expect(facts).toMatch(/On the calendar 5 h 30 m 6 events/);
    expect(facts).toMatch(/At the desk about \d+ h( \d+ m)? from \d+ messages 12 mails sent \d+ document edits/);
    expect(facts).toMatch(/Threads ran 34 h 10 m not counted in your hours/);
    // Money's own sums for the same days, in its own figures, both in the foreground; a job with no ledger has no such line.
    expect(facts).toMatch(/Money \$2,400\.00 in \$312\.50 out$/);
    const sums = [...cosmic.querySelectorAll("dd")].at(-1)!;
    expect([...sums.querySelectorAll(".text-foreground")].map(text)).toEqual(["$2,400.00 in", "$312.50 out"]);
    const purdue = section("Hours").querySelector('[data-review-job="purdue"]')!;
    fireEvent.click(within(purdue as HTMLElement).getByRole("button"));
    expect(text(purdue.querySelector("dl")!)).not.toContain("Money");
  });

  it("leads each shipped row with what happened, five a job, then Show all", () => {
    const { props } = draw("full");
    const cosmic = section("Shipped").querySelector('[data-review-shipped="cosmic"]') as HTMLElement;
    const rows = () => [...cosmic.querySelectorAll('[data-slot="item"]')].map(text);
    expect(rows()).toHaveLength(5);
    expect(rows()[0]).toMatch(/^Sent .+ to Riley Okafor (Mon|Tue|Wed|Thu|Fri)$/);
    // "Show all" goes once pressed; the keyboard carries on from the first row it brought.
    const all = within(cosmic).getByRole("button", { name: "Show all 15 shipped in Cosmic" });
    expect(all.textContent).toBe("Show all 15");
    fireEvent.click(all);
    expect(rows()).toHaveLength(15);
    expect(document.activeElement).toBe(cosmic.querySelectorAll("[data-review-shipped-row]")[5]);
    expect(rows().some((r) => r.startsWith("Finished Fix the crate drop rates"))).toBe(true);
    expect(rows().some((r) => r.startsWith("Riley Okafor answered Dev server budget"))).toBe(true);
    // A job with nothing out is not listed here; a row opens its thing.
    expect(section("Shipped").querySelector('[data-review-shipped="unify"]')).toBeNull();
    fireEvent.click(within(cosmic).getAllByRole("button")[0]!);
    expect(props.onOpen).toHaveBeenCalledWith(expect.objectContaining({ key: "cosmic" }), expect.objectContaining({ at: "mail" }));
    expect(text(section("Shipped"))).toContain("Approved Post the bracket to #esports");
  });

  it("says each slipped thing by its own title and one detail, with three presses named for its kind", () => {
    const { props } = draw("full");
    const slipped = section("Slipped");
    const row = (key: string) => slipped.querySelector(`[data-review-row="${key}"]`) as HTMLElement;
    expect(text(row("task:k1"))).toBe("Send the thumbnail drafts due Tue Done Next week Drop");
    expect(within(row("task:k1")).getAllByRole("button").map((b) => b.textContent ?? b.getAttribute("aria-label"))).toEqual(["", "Done", "Next week", "Drop"]);
    expect(row("task:k1").textContent).toContain("due Tue");
    expect(row("mail:tw1").textContent).toContain("sent Nov 12 to Sam Lindqvist");
    expect(within(row("mail:tw1")).getAllByRole("button").slice(1).map((b) => b.textContent)).toEqual(["Nudge", "Next week", "Stop waiting"]);
    expect(row("meeting:e8").textContent).toContain("Thu 2:00 PM with Dana Reyes and 3 others, nothing sent after");
    expect(within(row("meeting:e8")).getAllByRole("button").slice(1).map((b) => b.textContent)).toEqual(["Follow up", "Next week", "None needed"]);
    expect(row("env-box:held:host:h1").textContent).toContain("held since Tue");
    expect(within(row("env-box:held:host:h1")).getAllByRole("button").slice(1).map((b) => b.textContent)).toEqual(["Open", "Next week", "Discard"]);

    // A verb's name carries its row, so three jobs' "Next week" are told apart.
    fireEvent.click(within(row("task:k1")).getByRole("button", { name: "Next week: Send the thumbnail drafts" }));
    expect(props.onPress).toHaveBeenCalledWith(expect.objectContaining({ key: "hypixel" }), expect.objectContaining({ key: "task:k1" }), "later");
    // The row itself opens its thing; a press on a verb does not.
    expect(props.onOpen).not.toHaveBeenCalled();
    fireEvent.click(within(row("task:k1")).getByRole("button", { name: "Open Send the thumbnail drafts" }));
    expect(props.onOpen).toHaveBeenCalledWith(expect.objectContaining({ key: "hypixel" }), { at: "task", id: "k1" });
  });

  it("folds tasks due before the week behind a count, so this week's lead", () => {
    draw("full");
    const purdue = section("Slipped").querySelector('[data-review-slipped="purdue"]') as HTMLElement;
    expect(purdue.querySelector('[data-review-row="task:k3"]')).toBeNull();
    fireEvent.click(within(purdue).getByRole("button", { name: "3 older" }));
    expect(purdue.querySelector('[data-review-row="task:k3"]')!.textContent).toContain("due Nov 7");
  });

  it("makes a settled row leave, and the group with its last row", () => {
    draw("full", { gone: new Set(["task:k1", "mail:tw1"]) });
    const slipped = section("Slipped");
    const leaving = slipped.querySelector('[data-review-row="task:k1"]')!.closest("[data-leaving]") as HTMLElement;
    expect(leaving.className).toContain("grid-rows-[0fr]");
    expect(leaving.className).toContain("motion-reduce:transition-none");
    expect(leaving.hasAttribute("inert")).toBe(true);
    // Hypixel's two rows are both gone: its heading goes with them.
    expect(slipped.querySelector('[data-review-slipped="hypixel"]')!.closest("[data-leaving]")!.hasAttribute("inert")).toBe(true);
    expect(slipped.querySelector('[data-review-slipped="purdue"]')!.closest("[data-leaving]")).toBeNull();
    // The group after one that left stands 16px under nothing: its own space went with the group before it.
    expect(slipped.querySelector('[data-review-slipped="purdue"]')!.className).toContain("pt-0");
  });

  it("opens a job's row to what its threads ran though none of the time was his", () => {
    const { view, now } = fixtureView("full");
    const hours = view.review!.hours.map((h) => (h.job === "unify" ? { ...h, ranMs: 3_600_000 } : h));
    draw("full", { view: { ...view, review: { ...view.review!, hours } }, now });
    const unify = section("Hours").querySelector('[data-review-job="unify"]') as HTMLElement;
    expect(text(unify)).toBe("Unify Nothing seen about 6 h 15 m the week before");
    expect(unify.querySelector("[data-review-bar]")).toBeNull();
    fireEvent.click(within(unify).getByRole("button"));
    expect(text(unify.querySelector("dl")!)).toBe("Threads ran 1 h not counted in your hours");
  });

  it("keeps the verbs in sight while the host works, wherever the pointer and the focus went", () => {
    const onPress = vi.fn(() => new Promise<void>(() => {}));
    draw("full", { onPress });
    const row = section("Slipped").querySelector('[data-review-row="task:k1"]') as HTMLElement;
    const verbs = row.querySelector("button[aria-label^='Done']")!.parentElement!.parentElement!;
    expect(verbs.className).toContain("opacity-0");
    fireEvent.click(within(row).getByRole("button", { name: "Done: Send the thumbnail drafts" }));
    expect(verbs.className).not.toContain("opacity-0");
    // On the row's own fill, which a wait holds as a hover does; the keyboard in the row holds it too.
    expect(row.className).toMatch(/(^| )bg-foreground\/5( |$)/);
    expect(row.className).toContain("has-focus-visible:bg-foreground/5");
    // 2px inside the row, so the row's focus ring is whole round them.
    expect(verbs.className).toContain("inset-y-0.5");
    expect(verbs.className).toContain("end-0.5");
  });

  it("turns Follow up off where the meeting's job has no workspace this window can open; the other two still go", () => {
    draw("full", { canOpen: () => false });
    const row = section("Slipped").querySelector('[data-review-row="meeting:e8"]') as HTMLElement;
    expect(within(row).getAllByRole("button").map((b) => [b.textContent, (b as HTMLButtonElement).disabled])).toEqual([
      ["Follow up", true],
      ["Next week", false],
      ["None needed", false],
    ]);
    const task = section("Slipped").querySelector('[data-review-row="task:k1"]') as HTMLElement;
    expect(within(task).getAllByRole("button").every((b) => !(b as HTMLButtonElement).disabled)).toBe(true);
  });

  it("keeps a settled row away only until a read of the week no longer lists it as open", () => {
    const keys = new Set(["task:k1", "task:k2"]);
    // Still listed: the read is from before the press landed.
    expect(stillAway(keys, [{ key: "task:k1", open: true }, { key: "task:k2", open: true }])).toBe(keys);
    // Gone, or dealt with: the week's own reads say what is there from now on, so a thing reopened elsewhere comes back.
    expect([...stillAway(keys, [{ key: "task:k1", open: true }, { key: "task:k2", open: false }])]).toEqual(["task:k1"]);
    expect([...stillAway(keys, [])]).toEqual([]);
  });

  it("keeps the rows behind a fold whole: its panel clips at their hover box", () => {
    draw("full", { peek: { folds: true } });
    const older = section("Slipped").querySelector('[data-review-row="task:k3"]')!;
    expect(older.closest('[data-slot="collapsible-content"]')!.className).toContain("-mx-2 px-2");
  });

  it("counts behind the older fold only what is still there, and the fold goes with its last row", () => {
    const { rerender, props } = draw("full", { gone: new Set(["task:k3"]), peek: { folds: true } });
    const purdue = () => section("Slipped").querySelector('[data-review-slipped="purdue"]') as HTMLElement;
    expect(within(purdue()).getByRole("button", { name: "2 older" })).toBeTruthy();
    rerender(<ReviewPageView {...props} gone={new Set(["task:k3", "task:k4", "task:k5"])} />);
    expect(purdue().querySelector('[data-review-row="task:k5"]')!.closest("[data-leaving]")!.parentElement!.closest("[data-leaving]")!.hasAttribute("inert")).toBe(true);
    expect(purdue().closest("[data-leaving]")).toBeNull();
  });

  it("says Nothing slipped after the last group, once every row has left", () => {
    const { view } = fixtureView("full");
    const every = new Set(view.review!.slipped.map((r) => r.key));
    draw("full", { gone: every });
    const slipped = section("Slipped");
    const empty = slipped.querySelector("[data-review-empty]")!;
    expect(text(empty)).toBe("Nothing slipped");
    // After the groups, taking the last one's place as it leaves.
    expect(empty.previousElementSibling!.querySelector("[data-review-slipped]")).not.toBeNull();
    expect(empty.className).toContain("starting:grid-rows-[0fr]");
  });

  it("spins the verb pressed, and hands the keyboard to the next row when the row leaves", async () => {
    let done!: () => void;
    const onPress = vi.fn(() => new Promise<void>((resolve) => (done = resolve)));
    const { rerender, props } = draw("full", { onPress });
    const row = (key: string) => section("Slipped").querySelector(`[data-review-row="${key}"]`) as HTMLElement;
    const verb = within(row("task:k1")).getByRole("button", { name: "Done: Send the thumbnail drafts" }) as HTMLButtonElement;
    verb.focus();
    fireEvent.click(verb);
    expect(verb.querySelector('[data-slot="busy-label"]')!.hasAttribute("data-busy")).toBe(true);
    expect(within(row("task:k1")).getAllByRole("button").filter((b) => (b as HTMLButtonElement).disabled)).toHaveLength(3);
    rerender(<ReviewPageView {...props} gone={new Set(["task:k1"])} />);
    expect(document.activeElement).toBe(row("mail:tw1").querySelector("[data-row-open]"));
    await act(async () => done());
  });

  it("hands the keyboard past a verb that is off, and to the section's heading when no row is left", () => {
    // Hypixel's mail row leaves; the row after it is the meeting, whose job has no workspace here: no opener, Follow up off.
    const onPress = vi.fn(() => new Promise<void>(() => {}));
    const { rerender, props } = draw("full", { onPress, canOpen: (_job, target) => target.at !== "meeting" && target.at !== "mail" });
    const row = (key: string) => section("Slipped").querySelector(`[data-review-row="${key}"]`) as HTMLElement;
    const verb = within(row("mail:tw1")).getByRole("button", { name: "Stop waiting: Winter video schedule" });
    verb.focus();
    fireEvent.click(verb);
    rerender(<ReviewPageView {...props} gone={new Set(["mail:tw1"])} />);
    expect(document.activeElement).toBe(within(row("meeting:e8")).getByRole("button", { name: "Next week: Budget review" }));
    cleanup();
    const one = draw("full", { onPress });
    const all = one.view.review!.slipped.filter((r) => r.open).map((r) => r.key);
    const last = within(row("task:k1")).getByRole("button", { name: "Done: Send the thumbnail drafts" });
    last.focus();
    fireEvent.click(last);
    one.rerender(<ReviewPageView {...one.props} gone={new Set(all)} />);
    expect(document.activeElement).toBe(section("Slipped").querySelector("[data-review-heading]"));
  });

  it("gives the keyboard back to the verb when a press leaves the row standing", async () => {
    let done!: () => void;
    const onPress = vi.fn(() => new Promise<void>((resolve) => (done = resolve)));
    draw("full", { onPress });
    const row = section("Slipped").querySelector('[data-review-row="task:k1"]') as HTMLElement;
    const verb = within(row).getByRole("button", { name: "Drop: Send the thumbnail drafts" }) as HTMLButtonElement;
    verb.focus();
    fireEvent.click(verb);
    // A disabled button cannot hold focus: the browser drops it to the page.
    verb.blur();
    await act(async () => done());
    expect(verb.disabled).toBe(false);
    expect(document.activeElement).toBe(verb);
  });

  it("carries no badge, count on a heading, score or praise", () => {
    const { container } = draw("full");
    expect(container.querySelector('[data-slot="badge"]')).toBeNull();
    for (const word of ["Great", "Well done", "streak", "points", "score", "%"]) expect(text(container)).not.toContain(word);
  });
});

describe("the other states", () => {
  it("a week so far says so, and compares with the same span of the week before", () => {
    const { container } = draw("sofar");
    expect(text(container.querySelector("[data-review-made]")!)).toBe("So far, made 2:02 PM");
    expect(text(section("Hours"))).toContain("by this point last week");
  });

  it("a kept week keeps what slipped as it stood, with rows dealt with since under their own fold, with no presses", () => {
    draw("back");
    const slipped = section("Slipped");
    expect(slipped.querySelector('[data-review-row="task:k2"]')).toBeNull();
    expect(slipped.querySelector('[data-review-row="meeting:e8"]')).toBeNull();
    // The count first, as "3 older": "Dealt with since 2" would read as since two o'clock.
    const fold = within(slipped).getByRole("button", { name: "2 dealt with since" });
    fireEvent.click(fold);
    const dealt = [...slipped.querySelectorAll("[data-review-dealt]")];
    expect(dealt.map(text)).toEqual(["Budget review", "File the travel reimbursements"]);
    for (const row of dealt) expect(row.querySelector("button")).toBeNull();
  });

  it("ends on one line when nothing slipped", () => {
    draw("clear");
    expect(text(section("Slipped"))).toBe("Slipped Nothing slipped");
  });

  it("a host that is off is one muted line and the page stands", () => {
    const { container } = draw("off");
    expect(text(container.querySelector("[data-review-off]")!)).toBe("The Mac is off. Its threads and held items are not counted.");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(section("Hours").querySelectorAll("[data-review-job]")).toHaveLength(6);
    // Its threads were not read, so a job with no hours is known only to have nothing on the calendar. It is out of
    // both weeks alike, so the week before is still compared.
    expect(text(section("Hours").querySelector('[data-review-job="unify"]')!)).toBe("Unify Nothing on the calendar about 6 h 15 m the week before");
  });

  it("with LifeOS not answering it says so once, claims no empty list, and still shows what the hosts hold", () => {
    const { container } = draw("lifeos");
    expect([...container.querySelectorAll('[role="alert"]')].map(text)).toEqual([LEFT.lifeos]);
    // What this host itself sent on his press still shows; nothing claims the rest is empty.
    expect(text(section("Shipped"))).toBe("Shipped Purdue Approved Post the bracket to #esports Thu");
    expect(section("Slipped").querySelector('[data-review-row="env-box:held:host:h1"]')).not.toBeNull();
    expect(text(section("Slipped"))).not.toContain("Nothing slipped");
    // Hours claims no "nothing" either: without the calendar only the desk is known to be empty, no calendar fact
    // is stated, and the key keeps the one sentence that still holds.
    const hours = section("Hours");
    // Neither the calendar nor the mail he sent was read: nothing is known of a job with no hours.
    expect(text(hours.querySelector('[data-review-job="ref"]')!)).toBe(`Ref ${NOT_KNOWN}`);
    expect(text(hours)).not.toContain("Nothing seen");
    expect(text([...hours.querySelectorAll("p")].at(-1)!)).toBe(DESK_NOTE);
    fireEvent.click(within(hours.querySelector('[data-review-job="purdue"]') as HTMLElement).getByRole("button"));
    expect(text(hours.querySelector('[data-review-job="purdue"] dl')!)).not.toContain("On the calendar");
  });

  it("names a host that did not answer with Retry; a source that feeds several sections once, over them; one that feeds Hours alone, there", () => {
    const { container, props } = draw("failed");
    const alerts = [...container.querySelectorAll('[role="alert"]')].map(text);
    // Held items are Shipped's approvals, Slipped's rows and desk time: said once, over the sections, as a host is.
    expect(alerts).toEqual(["The Mac did not answer: it timed out.", LEFT.held, LEFT.threads]);
    expect(within(section("Hours")).getByRole("alert").textContent).toBe(LEFT.threads);
    expect(within(section("Slipped")).queryByRole("alert")).toBeNull();
    // One Retry on the page, on its first red line; it asks every host again and spins while they answer.
    const retry = screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement;
    expect(retry.closest("div")!.querySelector('[role="alert"]')!.textContent).toBe("The Mac did not answer: it timed out.");
    fireEvent.click(retry);
    expect(props.onRetry).toHaveBeenCalledWith();
    expect(retry.disabled).toBe(true);
    // Half the facts make no comparison: with threads unread, no row says "down from", and a job with no hours
    // is not said to have had none.
    expect(text(section("Hours"))).not.toMatch(/ from about|the week before/);
    expect(text(section("Hours").querySelector('[data-review-job="unify"]')!)).toBe("Unify Nothing on the calendar");
  });

  it("puts the keyboard back on Retry, or on the first heading when nothing is red any more", async () => {
    let done!: () => void;
    const onRetry = vi.fn(() => new Promise<void>((resolve) => (done = resolve)));
    const { rerender, props } = draw("failed", { onRetry });
    const retry = screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement;
    retry.focus();
    fireEvent.click(retry);
    retry.blur();
    await act(async () => done());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Retry" }));
    // The next round clears every red line.
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    (document.activeElement as HTMLElement).blur();
    const { view, now } = fixtureView("full");
    rerender(<ReviewPageView {...props} view={view} now={now} />);
    await act(async () => done());
    // The heading's words are the target, with the app's own ring: a bare heading would draw the browser's.
    const heading = screen.getByRole("heading", { name: "Hours", level: 2 }).querySelector("[data-review-heading]")!;
    expect(document.activeElement).toBe(heading);
    expect(heading.className).toContain("focus-ring");
  });

  it("puts the one Retry on Hours' own line when nothing over the sections is red", () => {
    const { view, now } = fixtureView("full");
    const { props } = draw("full", { view: { ...view, review: { ...view.review!, left: [LEFT.threads] } }, now });
    const retry = screen.getByRole("button", { name: "Retry" });
    expect(section("Hours").contains(retry)).toBe(true);
    fireEvent.click(retry);
    expect(props.onRetry).toHaveBeenCalledTimes(1);
  });

  it("claims no empty list where a source of it did not answer: one muted line says it is not whole, and the red line over the sections says why", () => {
    const { view, now } = fixtureView("full");
    const bare = (left: string[]) => ({ ...view, review: { ...view.review!, shipped: [], slipped: [], left, known: { calendar: !left.includes(LEFT.calendar), calendarCounted: !left.includes(LEFT.calendar), desk: true, shipped: !left.includes(LEFT.held), slipped: false } } });
    const { unmount, container } = render(<ReviewPageView view={bare([LEFT.calendar])} now={now} gone={new Set()} canOpen={() => true} onOpen={vi.fn()} onPress={vi.fn()} onRetry={vi.fn()} />);
    expect(text(section("Slipped"))).toBe("Slipped Some of it could not be read");
    expect(text(section("Shipped"))).toBe("Shipped Nothing went out");
    expect([...container.querySelectorAll('[role="alert"]')].map(text)).toEqual([LEFT.calendar]);
    unmount();
    render(<ReviewPageView view={bare([LEFT.held])} now={now} gone={new Set()} canOpen={() => true} onOpen={vi.fn()} onPress={vi.fn()} onRetry={vi.fn()} />);
    expect(text(section("Slipped"))).toBe("Slipped Some of it could not be read");
    expect(text(section("Shipped"))).toBe("Shipped Some of it could not be read");
  });

  it("says a list read in part as a muted fact with no Retry, which would read the same cut list again", () => {
    const { view, now } = fixtureView("full");
    const { container } = draw("full", { view: { ...view, review: { ...view.review!, left: [LEFT.heldPart, LEFT.filesPart], known: { ...view.review!.known, desk: false, shipped: false, slipped: false } } }, now });
    expect([...container.querySelectorAll("[data-review-part]")].map(text)).toEqual([LEFT.heldPart, LEFT.filesPart]);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("says a kept calendar standing in is counted, and shows its fact with the hours that count it", () => {
    const { view, now } = fixtureView("full");
    const { container } = draw("full", { view: { ...view, review: { ...view.review!, left: [LEFT.calendarKept], compare: [] } }, now });
    expect([...container.querySelectorAll('[role="alert"]')].map(text)).toEqual([LEFT.calendarKept]);
    const hours = section("Hours");
    fireEvent.click(within(hours.querySelector('[data-review-job="purdue"]') as HTMLElement).getByRole("button"));
    expect(text(hours.querySelector('[data-review-job="purdue"] dl')!)).toContain("On the calendar");
    expect(text(hours)).toContain("Calendar time is measured.");
  });

  it("waits, and claims nothing, while a host is still answering: an empty list and a job with no hours are bones until all are in", () => {
    const { view, now } = fixtureView("clear");
    // The first host is in; the second has not answered yet, so "nothing" is not known and nothing has failed.
    const partial = { ...view, settled: false, review: { ...view.review!, known: { calendar: true, calendarCounted: true, desk: false, shipped: false, slipped: false } } };
    const { rerender, props, container } = draw("clear", { view: partial, now });
    expect(text(section("Slipped"))).toBe("Slipped");
    expect(section("Slipped").querySelector("[data-review-pending]")).not.toBeNull();
    expect(text(section("Hours").querySelector('[data-review-job="unify"]')!)).toBe("Unify about 6 h 15 m the week before");
    expect(section("Hours").querySelector('[data-review-job="unify"] [data-review-pending]')).not.toBeNull();
    expect(text(container)).not.toContain("could not be read");
    rerender(<ReviewPageView {...props} view={view} />);
    expect(text(section("Slipped"))).toBe("Slipped Nothing slipped");
    expect(container.querySelector("[data-review-pending]")).toBeNull();
  });

  it("says a host's last answer is shown when it is, and holds the presses of rows nobody could check", () => {
    const { view, now } = fixtureView("full");
    const rows = view.review!.slipped.map((r) => (r.ref.kind === "task" ? { ...r, unchecked: true } : r));
    const { container } = draw("full", { view: { ...view, errors: [{ environmentId: "env-mac", name: "The Mac", error: "it timed out", kept: true }], review: { ...view.review!, slipped: rows } }, now });
    expect(text(container.querySelector('[role="alert"]')!)).toBe("The Mac did not answer: it timed out. Its last answer is shown.");
    expect(text(container.querySelector("[data-review-last-known]")!)).toBe("Slipped shows what was last known.");
    const off = (key: string) => within(section("Slipped").querySelector(`[data-review-row="${key}"]`) as HTMLElement).getAllByRole("button").slice(1).map((b) => (b as HTMLButtonElement).disabled);
    expect(off("task:k1")).toEqual([true, true, true]);
    expect(off("mail:tw1")).toEqual([false, false, false]);
    // A held item's Open only shows it in the Outbox: it stays, its other two wait.
    cleanup();
    const held = view.review!.slipped.map((r) => (r.ref.kind === "held" ? { ...r, unchecked: true } : r));
    draw("full", { view: { ...view, review: { ...view.review!, slipped: held } }, now });
    expect(off("env-box:held:host:h1")).toEqual([false, true, true]);
    // A host whose own line says its last answer is shown says it once: no second line for its rows.
    cleanup();
    const macs = view.review!.slipped.map((r) => (r.ref.kind === "held" ? { ...r, environmentId: "env-mac", unchecked: true } : r));
    const once = draw("full", { view: { ...view, errors: [{ environmentId: "env-mac", name: "The Mac", error: "it timed out", kept: true }], review: { ...view.review!, slipped: macs } }, now });
    expect(once.container.querySelector("[data-review-last-known]")).toBeNull();
  });

  it("turns Nudge off, as Follow up, where the job has no workspace this window can open", () => {
    draw("full", { canOpen: () => false });
    const row = section("Slipped").querySelector('[data-review-row="mail:tw1"]') as HTMLElement;
    expect(within(row).getAllByRole("button").map((b) => [b.textContent, (b as HTMLButtonElement).disabled])).toEqual([
      ["Nudge", true],
      ["Next week", false],
      ["Stop waiting", false],
    ]);
  });

  it("says a week is being made again in its first line, the rows standing", () => {
    const { view, now } = fixtureView("full");
    const { container } = draw("full", { view: { ...view, making: true }, now });
    const made = container.querySelector("[data-review-made]")!;
    expect(text(made)).toBe("Making…");
    expect(made.querySelector('[data-slot="spinner"]')).not.toBeNull();
    expect(section("Hours").querySelectorAll("[data-review-job]")).toHaveLength(6);
  });

  it("shows the sections' bones until the first host answers", () => {
    const { container } = draw("loading");
    expect([...container.querySelectorAll("h2")].map((h) => h.textContent)).toEqual(["Hours", "Shipped", "Slipped"]);
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(20);
    expect(container.querySelector("[data-review-made]")).toBeNull();
    expect(container.querySelector("[data-review-job]")).toBeNull();
    // One thing is read out of the wait; the bones are for the eye, and Slipped's have nothing at a row's end.
    expect(screen.getAllByRole("status").map(text)).toEqual(["Loading the review"]);
    for (const bones of container.querySelectorAll("section")) expect(bones.getAttribute("aria-hidden")).toBe("true");
    const ends = (title: string) => [...container.querySelectorAll("section")].find((s) => s.querySelector("h2")!.textContent === title)!.querySelectorAll(".ms-auto").length;
    expect([ends("Shipped"), ends("Slipped")]).toEqual([6, 0]);
  });

  it("claims no empty list while LifeOS has not answered", () => {
    const { view, now } = fixtureView("lifeos");
    const bare = { ...view, review: { ...view.review!, shipped: [], slipped: [] } };
    render(<ReviewPageView view={bare} now={now} gone={new Set()} canOpen={() => true} onOpen={vi.fn()} onPress={vi.fn()} onRetry={vi.fn()} />);
    expect(text(section("Shipped"))).toBe("Shipped Not known while LifeOS does not answer");
    expect(text(section("Slipped"))).toBe("Slipped Not known while LifeOS does not answer");
  });

  it("makes a row plain where its job has no workspace this window can open", () => {
    draw("full", { canOpen: () => false });
    expect(section("Slipped").querySelector("[data-row-open]")).toBeNull();
    expect(section("Shipped").querySelector('[data-review-shipped="cosmic"] button[data-slot="item"]')).toBeNull();
  });
});

describe("the head", () => {
  it("shows the week, steps it, never past this week, and offers This week only when another shows", () => {
    const onStep = vi.fn();
    const onThisWeek = vi.fn();
    const { rerender, container } = render(<HeadView label="Week of Nov 16" thisWeek onStep={onStep} onThisWeek={onThisWeek} />);
    expect(text(container.querySelector("[data-review-week]")!)).toBe("Week of Nov 16");
    expect((screen.getByRole("button", { name: "Next week" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "This week" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Previous week" }));
    expect(onStep).toHaveBeenCalledWith(-1);
    rerender(<HeadView label="Week of Nov 9" thisWeek={false} onStep={onStep} onThisWeek={onThisWeek} />);
    fireEvent.click(screen.getByRole("button", { name: "Next week" }));
    expect(onStep).toHaveBeenLastCalledWith(1);
    // Back on this week "This week" is gone and Next is off: the keyboard, which was on it, goes to Previous.
    const back = screen.getByRole("button", { name: "This week" });
    back.focus();
    fireEvent.click(back);
    expect(onThisWeek).toHaveBeenCalled();
    rerender(<HeadView label="Week of Nov 16" thisWeek onStep={onStep} onThisWeek={onThisWeek} />);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Previous week" }));
    rerender(<HeadView label="Week of Nov 9" thisWeek={false} onStep={onStep} onThisWeek={onThisWeek} />);
    // One height for the group, and what a window under 520px gives up: "This week" and the words before the day.
    expect(screen.getAllByRole("button").map((b) => (b.className.match(/\b(?:h|size)-7\b/) ? 28 : 0))).toEqual([28, 28, 28]);
    expect(screen.getByRole("button", { name: "This week" }).className).toContain("max-[520px]:hidden");
    const week = container.querySelector("[data-review-week]")!;
    expect(week.querySelector(".max-\\[520px\\]\\:hidden")!.textContent).toBe("Week of ");
    expect(text(week)).toBe("Week of Nov 9");
  });
});
