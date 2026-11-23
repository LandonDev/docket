// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HOURS_NOTE, LEFT } from "@shared/work/review";
import { fixtureView, type FixtureState } from "./fixtures";
import { HeadView } from "./Head";
import { ReviewPageView } from "./ReviewPage";

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
    expect(rows.find((r) => r.startsWith("Unify"))).toBe("Unify Nothing seen this week about 6 h 15 m last week");
    // The week before is said only where it says something: Purdue rose by hours, the others moved little.
    expect(rows.filter((r) => r.includes("last week") || r.includes(" from "))).toHaveLength(2);
    expect(rows.find((r) => r.startsWith("Purdue"))).toMatch(/^Purdue about \d+ h( \d+ m)? up from about \d+ h( \d+ m)?$/);
    expect(hours.querySelector("[data-starved] [data-review-bar]")).toBeNull();
    expect(text(hours)).toContain(HOURS_NOTE);
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
    expect(facts).toMatch(/On the calendar 5 h 30 m, 6 events/);
    expect(facts).toMatch(/At the desk about \d+ h( \d+ m)?, from \d+ messages, 12 mails sent, \d+ document edits/);
    expect(facts).toMatch(/Threads ran 34 h 10 m, not counted in your hours/);
    // Money's own sums for the same days, in its own figures; a job with no ledger has no such line.
    expect(facts).toMatch(/Money \$2,400\.00 in, \$312\.50 out$/);
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
    fireEvent.click(within(cosmic).getByRole("button", { name: "Show all 15" }));
    expect(rows()).toHaveLength(15);
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

    fireEvent.click(within(row("task:k1")).getByRole("button", { name: "Next week" }));
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
    const fold = within(slipped).getByRole("button", { name: /Dealt with since/ });
    expect(text(fold)).toBe("Dealt with since 2");
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
  });

  it("with LifeOS not answering it says so once, claims no empty list, and still shows what the hosts hold", () => {
    const { container } = draw("lifeos");
    expect([...container.querySelectorAll('[role="alert"]')].map(text)).toEqual([LEFT.lifeos]);
    // What this host itself sent on his press still shows; nothing claims the rest is empty.
    expect(text(section("Shipped"))).toBe("Shipped Purdue Approved Post the bracket to #esports Thu");
    expect(section("Slipped").querySelector('[data-review-row="env-box:held:host:h1"]')).not.toBeNull();
    expect(text(section("Slipped"))).not.toContain("Nothing slipped");
  });

  it("names a host that did not answer with Retry, and each missing source in its own section", () => {
    const { container, props } = draw("failed");
    const alerts = [...container.querySelectorAll('[role="alert"]')].map(text);
    expect(alerts).toEqual(["The Mac did not answer: the request timed out", LEFT.threads, LEFT.held]);
    expect(within(section("Hours")).getByRole("alert").textContent).toBe(LEFT.threads);
    expect(within(section("Slipped")).getByRole("alert").textContent).toBe(LEFT.held);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(props.onRetry).toHaveBeenCalledWith("env-mac");
  });

  it("shows the sections' bones until the first host answers", () => {
    const { container } = draw("loading");
    expect([...container.querySelectorAll("h2")].map((h) => h.textContent)).toEqual(["Hours", "Shipped", "Slipped"]);
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(20);
    expect(container.querySelector("[data-review-made]")).toBeNull();
    expect(container.querySelector("[data-review-job]")).toBeNull();
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
    fireEvent.click(screen.getByRole("button", { name: "This week" }));
    expect(onThisWeek).toHaveBeenCalled();
  });
});
