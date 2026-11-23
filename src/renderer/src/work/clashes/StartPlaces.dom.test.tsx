// @vitest-environment jsdom
/** Settings → Work, Start places: seven rows from LifeOS, each opening a dialog whose Save sends `settings:update` with that one place alone. */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StartPlaces } from "./places";

const lifeos = vi.hoisted(() => ({
  state: "connected" as string,
  loading: false,
  places: null as unknown,
  sent: [] as { name: string; args: unknown }[],
  refuse: null as string | null,
  failed: null as string | null,
}));
vi.mock("../shell/lifeos", async (original) => ({
  ...(await original<object>()),
  useLifeosSession: (environmentId: string) => ({
    environmentId,
    sector: null,
    state: lifeos.state,
    client:
      lifeos.state === "connected"
        ? {
            mutation: async (ref: never, args: unknown) => {
              lifeos.sent.push({ name: getFunctionName(ref), args });
              if (lifeos.refuse) throw new Error(lifeos.refuse);
              return null;
            },
          }
        : null,
  }),
  useLifeosQuery: (_session: unknown, name: string) => {
    if (lifeos.loading) return { status: "loading" };
    if (lifeos.failed) return { status: "failed", error: lifeos.failed };
    if (name === "settings:startPlaces") return { status: "ready", value: lifeos.places };
    if (name === "sectors:list") return { status: "ready", value: SECTORS };
    return { status: "loading" };
  },
}));

const { StartPlacesSection } = await import("./StartPlaces");

const SECTORS = [
  { key: "cosmic", label: "Cosmic", order: 0 },
  { key: "hypixel", label: "Hypixel", order: 1 },
  { key: "purdue", label: "Purdue", order: 2 },
  { key: "ref", label: "Ref", order: 3 },
  { key: "unify", label: "Unify", order: 4 },
  { key: "life", label: "Life", order: 5 },
];

const PLACES: StartPlaces = {
  home: { address: "9 Office Rd", label: "9 Office Road, Cedar Falls", state: "found" },
  jobs: [
    { sector: "cosmic", lookups: true, state: "none" },
    { sector: "hypixel", lookups: true, address: "5 Pine Ave", state: "looking" },
    { sector: "purdue", lookups: false, address: "Cedar Hall, 4 Elm St, Cedar Falls, IN", label: "Cedar Hall", state: "found" },
    { sector: "ref", lookups: true, address: "2 Gym Ln", state: "failed" },
    { sector: "unify", lookups: true, state: "none" },
    { sector: "life", lookups: true, state: "none" },
  ],
};

beforeEach(() => {
  lifeos.state = "connected";
  lifeos.loading = false;
  lifeos.places = PLACES;
  lifeos.sent = [];
  lifeos.refuse = null;
  lifeos.failed = null;
});
afterEach(cleanup);

const rows = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>("[data-start]")];
const row = (container: HTMLElement, target: string) => container.querySelector<HTMLElement>(`[data-start="${target}"]`)!;
/** A row's button is named "Change <whose>: <what the row says>": found here by whose. */
const open = async (name: string) => {
  fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${name}(:|$)`) }));
  await act(async () => {});
  return screen.getByRole("dialog");
};
const save = async (dialog: HTMLElement) => {
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  await act(async () => {});
};

describe("Start places", () => {
  it("draws seven rows, Home first, then the jobs in LifeOS's order", () => {
    const { container } = render(<StartPlacesSection environmentId="box" />);
    expect(screen.getByText("Start places")).toBeTruthy();
    expect(rows(container).map((r) => r.dataset.start)).toEqual(["home", "cosmic", "hypixel", "purdue", "ref", "unify", "life"]);
    expect(row(container, "purdue").textContent).toContain("Purdue");
  });

  it("says each place's state: Home where a job has none, Looking up…, the map's name, Not found", () => {
    const { container } = render(<StartPlacesSection environmentId="box" />);
    expect(row(container, "home").textContent).toContain("9 Office Road, Cedar Falls");
    expect(row(container, "cosmic").textContent).toBe("CosmicHome");
    expect(row(container, "hypixel").textContent).toContain("Looking up…");
    expect(row(container, "purdue").textContent).toContain("Cedar Hall");
    expect(row(container, "purdue").textContent).not.toContain("Elm St");
    const notFound = within(row(container, "ref")).getByText("Not found");
    expect(notFound.className).toContain("text-destructive");
    expect(row(container, "ref").textContent).toContain("2 Gym Ln");
  });

  it("Home with no address is not set", () => {
    lifeos.places = { ...PLACES, home: { state: "none" } };
    const { container } = render(<StartPlacesSection environmentId="box" />);
    expect(row(container, "home").textContent).toBe("HomeNot set");
  });

  it("draws nothing while the session is not connected", () => {
    lifeos.state = "signed-out";
    const { container } = render(<StartPlacesSection environmentId="box" />);
    expect(container.innerHTML).toBe("");
  });

  it("draws bones in the rows' shape while LifeOS reads", () => {
    lifeos.loading = true;
    const { container } = render(<StartPlacesSection environmentId="box" />);
    expect(container.querySelectorAll("[data-slot=page-row-skeleton]")).toHaveLength(7);
    expect(rows(container)).toHaveLength(0);
  });

  it("Change opens the dialog filled with the current address, Save disabled until something changes", async () => {
    render(<StartPlacesSection environmentId="box" />);
    const dialog = await open("Change Purdue");
    expect(within(dialog).getByText("Purdue")).toBeTruthy();
    const field = within(dialog).getByLabelText("Address") as HTMLInputElement;
    expect(field.value).toBe("Cedar Hall, 4 Elm St, Cedar Falls, IN");
    const confirm = within(dialog).getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(field, { target: { value: "Cedar Hall, 4 Elm St, Cedar Falls, IN " } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(field, { target: { value: "1 Mill St" } });
    expect(confirm.disabled).toBe(false);
  });

  it("Save on a job sends that job's start alone, then closes", async () => {
    render(<StartPlacesSection environmentId="box" />);
    const dialog = await open("Change Ref");
    fireEvent.change(within(dialog).getByLabelText("Address"), { target: { value: "3 Court St" } });
    await save(dialog);
    expect(lifeos.sent).toEqual([{ name: "settings:update", args: { startFor: { sector: "ref", address: "3 Court St" } } }]);
    await act(async () => void (await new Promise((r) => setTimeout(r, 400))));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("turning the switch sends that job's lookups alone, and nothing of another job", async () => {
    render(<StartPlacesSection environmentId="box" />);
    const dialog = await open("Change Purdue");
    const line = within(dialog).getByText("When off, this job's event places never leave your machines.");
    // The switch is described by the one sentence, so it is read on focus.
    expect(within(dialog).getByRole("switch", { name: "Look up event places on Apple Maps" }).getAttribute("aria-describedby")).toBe(line.id);
    const toggle = within(dialog).getByRole("switch");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    await save(dialog);
    expect(lifeos.sent).toEqual([{ name: "settings:update", args: { lookupsFor: { sector: "purdue", on: true } } }]);
  });

  it("Use home empties the address for Save to send, with a switch he flipped beside it, and shows only while there is an address", async () => {
    render(<StartPlacesSection environmentId="box" />);
    let dialog = await open("Change Cosmic");
    expect(within(dialog).queryByRole("button", { name: "Use home" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await act(async () => void (await new Promise((r) => setTimeout(r, 400))));
    dialog = await open("Change Hypixel");
    fireEvent.click(within(dialog).getByRole("switch"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Use home" }));
    // Nothing is sent yet: the field is empty, the verb is gone, and Save holds both changes.
    expect(lifeos.sent).toEqual([]);
    expect((within(dialog).getByLabelText("Address") as HTMLInputElement).value).toBe("");
    // The verb left with the address: the keyboard goes on from the field.
    expect(document.activeElement).toBe(within(dialog).getByLabelText("Address"));
    expect(within(dialog).queryByRole("button", { name: "Use home" })).toBeNull();
    await save(dialog);
    expect(lifeos.sent).toEqual([{ name: "settings:update", args: { startFor: { sector: "hypixel", address: "" }, lookupsFor: { sector: "hypixel", on: false } } }]);
  });

  it("names each row's button by what the row says, and turns a spinner while a place is looked up", () => {
    const { container } = render(<StartPlacesSection environmentId="box" />);
    expect(screen.getByRole("button", { name: "Change Cosmic: Home" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Change Ref: 2 Gym Ln.*, Not found$/ })).toBeTruthy();
    // The words say the wait; the turning mark is not read out beside them.
    expect(row(container, "hypixel").querySelector("[data-slot=spinner]")?.getAttribute("aria-hidden")).toBe("true");
    expect(row(container, "cosmic").querySelector("[data-slot=spinner]")).toBeNull();
  });

  it("the Home row's Save sends homeAddress, with no switch and no Use home", async () => {
    render(<StartPlacesSection environmentId="box" />);
    const dialog = await open("Change Home");
    expect(within(dialog).queryByRole("switch")).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Use home" })).toBeNull();
    fireEvent.change(within(dialog).getByLabelText("Address"), { target: { value: "12 Oak Ct" } });
    await save(dialog);
    expect(lifeos.sent).toEqual([{ name: "settings:update", args: { homeAddress: "12 Oak Ct" } }]);
  });

  it("keeps an open dialog and what he typed when a read fails, the session drops or a read is out, with Save waiting", async () => {
    const view = render(<StartPlacesSection environmentId="box" />);
    const dialog = await open("Change Purdue");
    fireEvent.change(within(dialog).getByLabelText("Address"), { target: { value: "12 Oak Ct" } });
    fireEvent.click(within(dialog).getByRole("switch"));
    const typed = () => (within(screen.getByRole("dialog")).getByLabelText("Address") as HTMLInputElement).value;
    const saveOff = () => (within(screen.getByRole("dialog")).getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled;
    expect(saveOff()).toBe(false);

    lifeos.failed = "LifeOS did not answer";
    view.rerender(<StartPlacesSection environmentId="box" />);
    await act(async () => {});
    expect(typed()).toBe("12 Oak Ct");
    expect(within(screen.getByRole("dialog")).getByRole("switch").getAttribute("aria-checked")).toBe("true");
    expect(saveOff()).toBe(true);
    expect(within(screen.getByRole("dialog")).getByRole("alert").textContent).toBe("LifeOS did not answer");

    lifeos.failed = null;
    lifeos.state = "unreachable";
    view.rerender(<StartPlacesSection environmentId="box" />);
    await act(async () => {});
    expect(typed()).toBe("12 Oak Ct");
    expect(saveOff()).toBe(true);

    lifeos.state = "connected";
    lifeos.loading = true;
    view.rerender(<StartPlacesSection environmentId="box" />);
    await act(async () => {});
    expect(typed()).toBe("12 Oak Ct");
    expect(saveOff()).toBe(true);
    // A session still connecting is a wait too, never "Not signed in", and comes before what an earlier read said.
    lifeos.loading = false;
    lifeos.failed = "LifeOS did not answer";
    lifeos.state = "connecting";
    view.rerender(<StartPlacesSection environmentId="box" />);
    await act(async () => {});
    expect(typed()).toBe("12 Oak Ct");
    expect(saveOff()).toBe(true);
    expect(within(screen.getByRole("dialog")).getByRole("status").textContent).toBe("Waiting for LifeOS…");
    expect(within(screen.getByRole("dialog")).getByRole("alert").textContent).toBe("");
    lifeos.failed = null;
    lifeos.state = "connected";
    lifeos.loading = true;
    view.rerender(<StartPlacesSection environmentId="box" />);
    await act(async () => {});
    // A read that is merely out says so as a wait, not as an error.
    expect(within(screen.getByRole("dialog")).getByRole("status").textContent).toBe("Waiting for LifeOS…");
    expect(within(screen.getByRole("dialog")).getByRole("alert").textContent).toBe("");

    // The reads are back: Save sends what he typed, with the switch.
    lifeos.loading = false;
    view.rerender(<StartPlacesSection environmentId="box" />);
    await act(async () => {});
    expect(saveOff()).toBe(false);
    await save(screen.getByRole("dialog"));
    expect(lifeos.sent).toHaveLength(1);
    expect(lifeos.sent[0]).toMatchObject({ name: "settings:update", args: { startFor: { sector: "purdue", address: "12 Oak Ct" }, lookupsFor: { sector: "purdue", on: true } } });
  });

  it("a refusal's words stay in the dialog", async () => {
    lifeos.refuse = "refused: that address is too long";
    render(<StartPlacesSection environmentId="box" />);
    const dialog = await open("Change Home");
    fireEvent.change(within(dialog).getByLabelText("Address"), { target: { value: "12 Oak Ct" } });
    await save(dialog);
    expect(within(screen.getByRole("dialog")).getByRole("alert").textContent).toBe("That address is too long");
  });

  it("says why LifeOS cannot be read now before what it said of an earlier Save, and the refusal again once the read is back", async () => {
    lifeos.refuse = "refused: that address is too long";
    const view = render(<StartPlacesSection environmentId="box" />);
    const dialog = await open("Change Home");
    fireEvent.change(within(dialog).getByLabelText("Address"), { target: { value: "12 Oak Ct" } });
    await save(dialog);
    const alert = () => within(screen.getByRole("dialog")).getByRole("alert").textContent;
    expect(alert()).toBe("That address is too long");
    lifeos.failed = "LifeOS did not answer";
    view.rerender(<StartPlacesSection environmentId="box" />);
    await act(async () => {});
    expect(alert()).toBe("LifeOS did not answer");
    lifeos.failed = null;
    view.rerender(<StartPlacesSection environmentId="box" />);
    await act(async () => {});
    expect(alert()).toBe("That address is too long");
    expect(within(screen.getByRole("dialog")).getByRole("status").textContent).toBe("");
  });
});
