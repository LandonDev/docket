// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expectModalShape } from "../../../chrome/modalShape.testkit";

/**
 * Add a computer… as one dialog: each way reached from the choice of four and opened directly; the caps each "It
 * may" choice sends; a sign-in for another computer asked of that computer's link and no other; Manage asks first;
 * the link's code, QR, countdown and Cancel the link; a bot's key shown once; set up's list; linking this Mac and
 * signing in again; and Escape and Cancel closing with nothing made.
 */

vi.mock("qrcode", () => ({ default: { toDataURL: async () => "data:image/png;base64,AA==" } }));
const workspaces = vi.hoisted(() => ({ list: [] as { id: string; name: string; kind: string }[] }));
vi.mock("../../../lib/tcserver/workspaces", async (original) => ({ ...(await original<typeof import("../../../lib/tcserver/workspaces")>()), useWorkspaces: () => workspaces.list }));

const { registry } = await import("../../../lib/connection");
const { resetOwnComputerForTests } = await import("../../../lib/settings/computerName");
const { tooltipChunk, warmTooltips } = await import("@renderer/components/ui/tooltip");
const { AddComputerDialog } = await import("./AddComputer");
const { endsText, addErrorWords, ALLOW_CAPS } = await import("./addWords");

type Call = { on: string; method: string; params: unknown };
const calls: Call[] = [];
let answers: Record<string, unknown> = {};
const fakeLink = (on: string) => ({
  environmentId: on,
  request: async (method: string, params: unknown) => {
    calls.push({ on, method, params });
    const answer = answers[method];
    if (answer instanceof Error) throw answer;
    return typeof answer === "function" ? (answer as (p: unknown) => unknown)(params) : answer;
  },
  onPush: () => () => {},
});
const ENVIRONMENTS = [
  { id: "local", name: "This Mac", routes: [], credentialRef: null },
  { id: "env_box", name: "The box", routes: [{ url: "wss://box.example.com/ws", kind: "tunnel" }], credentialRef: "env_box" },
];

const writeText = vi.fn(async () => undefined);
beforeAll(async () => {
  await tooltipChunk.load();
  warmTooltips();
});
beforeEach(() => {
  // This computer has said its name, so nothing asks it again.
  resetOwnComputerForTests("MacBook Pro");
  calls.length = 0;
  answers = {};
  workspaces.list = [];
  writeText.mockClear();
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  vi.spyOn(registry, "primary").mockReturnValue(fakeLink("local") as never);
  vi.spyOn(registry, "link").mockImplementation((id) => (id === "env_box" ? (fakeLink("env_box") as never) : undefined));
  vi.spyOn(registry, "environmentsSnapshot").mockReturnValue(ENVIRONMENTS as never);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const dialog = () => screen.getByRole("dialog");
const title = () => dialog().querySelector('[data-slot="dialog-title"]')!.textContent;
const made = (method: string) => calls.filter((c) => c.method === method);
const pairing = (over: Record<string, unknown> = {}) => ({
  pairing: { id: "p1", caps: ["read", "operate"], expiresAt: Date.now() + 9 * 60_000 + 41_000 },
  code: "ABCDE-12345",
  url: "https://box.example.com/pair#ABCDE-12345",
  ...over,
});
const name = (value: string) => fireEvent.change(screen.getByLabelText("Name"), { target: { value } });
const press = async (label: string | RegExp) => {
  await act(async () => fireEvent.click(screen.getByRole("button", { name: label })));
};

describe("the choice of four", () => {
  const ways = [
    ["Sign a device in to this Mac", "Sign a device in to this Mac"],
    ["Set up a new computer", "Set up a new computer"],
    ["Link this Mac to another computer", "Link this Mac to another computer"],
    ["Use a setup link on this Mac", "Use a setup link on this Mac"],
  ] as const;

  it("lists four ways, each with its line, and Continue opens the one picked", async () => {
    for (const [choice, next] of ways) {
      render(<AddComputerDialog onClose={() => {}} />);
      expect(title()).toBe("Add a computer");
      const group = screen.getByRole("radiogroup", { name: "Add a computer" });
      expect(within(group).getAllByRole("radio")).toHaveLength(4);
      const radio = screen.getByRole("radio", { name: choice });
      expect(document.getElementById(radio.getAttribute("aria-describedby")!)?.textContent).toBeTruthy();
      fireEvent.click(radio);
      await press("Continue");
      expect(title()).toBe(next);
      cleanup();
    }
  });

  it("opens a way directly, one step later", () => {
    for (const [way, heading] of [
      ["device", "Sign a device in to this Mac"],
      ["setup", "Set up a new computer"],
      ["link", "Link this Mac to another computer"],
      ["use-link", "Use a setup link on this Mac"],
    ] as const) {
      render(<AddComputerDialog ask={{ way }} onClose={() => {}} />);
      expect(title()).toBe(heading);
      expect(screen.queryByRole("radiogroup", { name: "Add a computer" })).toBeNull();
      cleanup();
    }
  });

  it("closes on Escape and on Cancel with nothing made", async () => {
    const onClose = vi.fn();
    render(<AddComputerDialog onClose={onClose} />);
    expectModalShape(dialog());
    fireEvent.keyDown(dialog(), { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    cleanup();
    render(<AddComputerDialog ask={{ way: "device" }} onClose={onClose} />);
    name("iPhone");
    await press("Cancel");
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(2));
    expect(made("remote.pairings.create")).toEqual([]);
    expect(made("remote.keys.create")).toEqual([]);
  });
});

describe("signing a device in", () => {
  it("sends the caps of each It may choice", async () => {
    answers["remote.pairings.create"] = pairing();
    for (const [choice, caps] of [
      ["Look only", ALLOW_CAPS.look],
      ["Run threads", ALLOW_CAPS.run],
      ["Run threads and approve", ALLOW_CAPS.approve],
    ] as const) {
      calls.length = 0;
      render(<AddComputerDialog ask={{ way: "device" }} onClose={() => {}} />);
      name("iPhone");
      fireEvent.click(screen.getByRole("radio", { name: choice }));
      await press("Make the link");
      await screen.findByText("ABCDE-12345");
      expect(made("remote.pairings.create")).toEqual([{ on: "local", method: "remote.pairings.create", params: { name: "iPhone", audience: "client", caps } }]);
      cleanup();
    }
    expect(ALLOW_CAPS).toEqual({ look: [], run: ["operate"], approve: ["operate", "approve"], manage: ["operate", "approve", "admin"] });
  });

  it("asks before a link that can manage the computer, and makes nothing on Cancel", async () => {
    answers["remote.pairings.create"] = pairing();
    render(<AddComputerDialog ask={{ way: "device" }} onClose={() => {}} />);
    name("Laptop");
    fireEvent.click(screen.getByRole("radio", { name: "Manage this Mac" }));
    await press("Make a link that can manage this Mac");
    const confirm = await screen.findByRole("alertdialog");
    expect(within(confirm).getByText("Let this device manage this Mac?")).toBeTruthy();
    await act(async () => fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" })));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(made("remote.pairings.create")).toEqual([]);

    await press("Make a link that can manage this Mac");
    await act(async () => fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Make the link" })));
    await screen.findByText("ABCDE-12345");
    expect(made("remote.pairings.create")[0].params).toEqual({ name: "Laptop", audience: "client", caps: ["operate", "approve", "admin"] });
  });

  it("asks another computer over that computer's own link, and no other", async () => {
    answers["remote.pairings.create"] = pairing();
    answers["remote.status"] = { publicOrigin: "https://box.example.com", learnedOrigin: null };
    render(<AddComputerDialog ask={{ way: "device", computer: "env_box" }} onClose={() => {}} />);
    expect(title()).toBe("Sign a device in to the box");
    expect(screen.getByRole("radio", { name: "Manage the box" })).toBeTruthy();
    name("iPhone");
    await press("Make the link");
    await screen.findByText("ABCDE-12345");
    expect(made("remote.pairings.create").map((c) => c.on)).toEqual(["env_box"]);
    expect(calls.filter((c) => c.on === "local" && c.method !== "remote.status")).toEqual([]);
    await press("Cancel the link");
    expect(made("remote.pairings.revoke")).toEqual([{ on: "env_box", method: "remote.pairings.revoke", params: { id: "p1" } }]);
  });

  it("shows the code, its QR, Copy link and the countdown; Cancel the link takes it back", async () => {
    answers["remote.pairings.create"] = pairing();
    const onClose = vi.fn();
    const onChanged = vi.fn();
    render(<AddComputerDialog ask={{ way: "device" }} onClose={onClose} onChanged={onChanged} />);
    expect(screen.getByRole("button", { name: "Make the link" }).hasAttribute("disabled")).toBe(true);
    name("iPhone");
    await press("Make the link");
    expect(await screen.findByText("ABCDE-12345")).toBeTruthy();
    expect(screen.getByAltText("Sign-in QR code")).toBeTruthy();
    expect(screen.getByText("box.example.com/pair").getAttribute("data-sign-in-link")).toBe("https://box.example.com/pair#ABCDE-12345");
    expect(dialog().querySelector("[data-link-ends]")!.textContent).toMatch(/^One use\. Ends in 9:4\d\.$/);
    await press("Copy link");
    expect(writeText).toHaveBeenCalledWith("https://box.example.com/pair#ABCDE-12345");
    expect(onChanged).toHaveBeenCalledOnce();
    expectModalShape(dialog(), { cancel: false });
    await press("Cancel the link");
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(made("remote.pairings.revoke")).toHaveLength(1);
    expect(onChanged).toHaveBeenCalledTimes(2);
  });

  it("says when a link has ended", () => {
    expect(endsText(582)).toBe("One use. Ends in 9:42.");
    expect(endsText(0)).toBe("This link has ended.");
    render(<AddComputerDialog ask={{ way: "device" }} onClose={() => {}} preview={{ made: { ...pairing(), pairing: { ...pairing().pairing, expiresAt: Date.now() - 1 } as never, qr: null } }} />);
    expect(dialog().querySelector("[data-link-ends]")!.textContent).toBe("This link has ended.");
  });

  it("says a refusal in the house's words, never the host's", async () => {
    answers["remote.pairings.create"] = new Error("forbidden: remote.pairings.create needs admin");
    render(<AddComputerDialog ask={{ way: "device", computer: "env_box" }} onClose={() => {}} />);
    name("iPhone");
    await press("Make the link");
    expect(await screen.findByText("This window's key may not add devices to the box. Do it from a computer that manages the box.")).toBeTruthy();
    expect(screen.queryByText(/forbidden/)).toBeNull();
    expect(addErrorWords(new Error("refused: the box is offline"), "the box")).toBe("The box is offline");
  });
});

describe("a sign-in link's address", () => {
  const create = async (): Promise<void> => {
    name("Laptop");
    answers["remote.pairings.create"] = pairing({ url: "http://127.0.0.1:7677/pair#ABCDE-12345" });
    await press("Make the link");
    await screen.findByText("ABCDE-12345");
  };

  it("builds the link and its QR on the address he set, else the one learned from the tunnel", async () => {
    answers["remote.status"] = { publicOrigin: "https://tc.example.com/", learnedOrigin: "https://tunnel.example.com" };
    render(<AddComputerDialog ask={{ way: "device" }} onClose={() => {}} />);
    await waitFor(() => expect(made("remote.status").length).toBeGreaterThan(0));
    await create();
    await press("Copy link");
    expect(writeText).toHaveBeenLastCalledWith("https://tc.example.com/pair#ABCDE-12345");
    expect(screen.getByAltText("Sign-in QR code")).toBeTruthy();
    cleanup();
    answers["remote.status"] = { publicOrigin: "", learnedOrigin: "https://tunnel.example.com" };
    render(<AddComputerDialog ask={{ way: "device" }} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Make the link" })).toBeTruthy());
    await create();
    await press("Copy link");
    expect(writeText).toHaveBeenLastCalledWith("https://tunnel.example.com/pair#ABCDE-12345");
  });

  it("says before the link is made that no other device reaches the computer, and then offers the code alone", async () => {
    answers["remote.status"] = { publicOrigin: "", learnedOrigin: null };
    render(<AddComputerDialog ask={{ way: "device" }} onClose={() => {}} />);
    expect((await screen.findByText("Other devices cannot reach this Mac yet. Set its Web address in Sharing, under Advanced.")).hasAttribute("data-pair-unreachable")).toBe(true);
    await create();
    expect(screen.queryByRole("button", { name: "Copy link" })).toBeNull();
    expect(screen.queryByAltText("Sign-in QR code")).toBeNull();
    await press("Copy code");
    expect(writeText).toHaveBeenCalledWith("ABCDE-12345");
  });

  it("says when the link opens only on the computer itself", async () => {
    render(<AddComputerDialog ask={{ way: "device" }} onClose={() => {}} />);
    await create();
    expect(screen.getByText("This Mac has no web address, so this link opens only on it.")).toBeTruthy();
    expect(screen.queryByAltText("Sign-in QR code")).toBeNull();
  });
});

describe("a key for a bot", () => {
  it("offers what a bot may hold, makes the key on the computer named, and shows it once", async () => {
    answers["remote.keys.create"] = { key: { id: "k1" }, token: "tc_k1.secret" };
    const onClose = vi.fn();
    render(<AddComputerDialog ask={{ way: "device", computer: "env_box" }} onClose={onClose} />);
    fireEvent.click(screen.getByRole("radio", { name: "Run threads and approve" }));
    fireEvent.click(screen.getByRole("button", { name: "A bot" }));
    expect(screen.getByText("A bot signs in with a key, shown once.")).toBeTruthy();
    expect(screen.getAllByRole("radio").map((r) => r.getAttribute("aria-labelledby") && document.getElementById(r.getAttribute("aria-labelledby")!)!.textContent)).toEqual(["Look only", "Run threads"]);
    expect(screen.getByRole("radio", { name: "Run threads" }).getAttribute("aria-checked")).toBe("true");
    name("grok");
    fireEvent.change(screen.getByLabelText("Webhook URL"), { target: { value: "https://bot.example.com/hook" } });
    await press("Make the key");
    expect(made("remote.keys.create")).toEqual([
      { on: "env_box", method: "remote.keys.create", params: { name: "grok", audience: "mcp", caps: ["operate"], webhookUrl: "https://bot.example.com/hook" } },
    ]);
    const key = (await screen.findByLabelText("Key")) as HTMLInputElement;
    expect(key.value).toBe("tc_k1.secret");
    expect(key.readOnly).toBe(true);
    expect(screen.getByText("Shown once. Copy it now.")).toBeTruthy();
    await press("Copy key");
    expect(writeText).toHaveBeenCalledWith("tc_k1.secret");
    expectModalShape(dialog(), { cancel: false });
    await press("Done");
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });
});

describe("setting up a new computer", () => {
  const LINK = "https://box.example.com/setup#v1.ABCDE-FGHIJ.secret";

  it("makes a link from the name and the list, then shows it with Copy, its end and Cancel the link", async () => {
    localStorage.clear();
    localStorage.setItem("docket.colorScheme", "light");
    localStorage.setItem("docket.defaultModels", JSON.stringify({ claude: "claude:opus" }));
    workspaces.list = [
      { id: "w1", name: "Purdue", kind: "work" },
      { id: "w2", name: "Hypixel", kind: "work" },
      { id: "c1", name: "temp-code", kind: "code" },
    ];
    answers["work.lifeos.status"] = { lifeos: { state: "connected" } };
    answers["devices.setup.make"] = { link: LINK, expiresAt: Date.now() + 15 * 60_000, pairingId: "p1" };
    answers["devices.setup.cancel"] = { ok: true };
    const onClose = vi.fn();
    render(<AddComputerDialog ask={{ way: "setup" }} onClose={onClose} />);
    const make = screen.getByRole("button", { name: "Make the link" }) as HTMLButtonElement;
    expect(make.disabled).toBe(true);
    const box = screen.getByRole("checkbox", { name: "Link to the box" });
    expect(box.getAttribute("aria-checked")).toBe("true");
    expect(box.hasAttribute("data-disabled")).toBe(true);
    expect(screen.getByRole("group", { name: "It gets" })).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "LifeOS signed in" }).getAttribute("aria-checked")).toBe("true"));
    fireEvent.click(screen.getByRole("checkbox", { name: "Hypixel" }));
    name("Purdue laptop");
    await press("Make the link");
    expect(made("devices.setup.make")[0].params).toEqual({
      name: "Purdue laptop",
      items: { accounts: true, lifeos: true, reader: true, folders: true },
      workspaces: ["w1"],
      seeds: { appearance: { code: "light", work: "light" }, defaultModels: { claude: "claude:opus" } },
    });
    expect(((await screen.findByLabelText("Link")) as HTMLInputElement).value).toBe(LINK);
    expect(screen.getByRole("button", { name: "Copy link" })).toBeTruthy();
    expect(dialog().querySelector("[data-link-ends]")!.textContent).toMatch(/^One use\. Ends in 1[45]:\d\d\.$/);
    await press("Cancel the link");
    await waitFor(() => expect(made("devices.setup.cancel")).toEqual([{ on: "local", method: "devices.setup.cancel", params: { pairingId: "p1" } }]));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it("leaves LifeOS and its reader off while this Mac's Work is not signed in", () => {
    render(<AddComputerDialog ask={{ way: "setup" }} onClose={() => {}} />);
    expect(screen.getByRole("checkbox", { name: "LifeOS signed in" }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("checkbox", { name: "Outlook and Teams reader" }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("checkbox", { name: "Folders in Files" }).getAttribute("aria-checked")).toBe("false");
  });
});

describe("linking this Mac to another computer", () => {
  const field = (key: string) => document.querySelector(`[data-environment-field="${key}"]`);

  it("keeps the e2e's fields and goes from a sign-in link to an address and key", async () => {
    answers["remote.environments.add"] = { id: "env_new", name: "Studio" };
    const onClose = vi.fn();
    render(<AddComputerDialog ask={{ way: "link" }} onClose={onClose} />);
    expect(field("link")).toBe(screen.getByLabelText("Sign-in link"));
    expect(field("name")).toBe(screen.getByLabelText("Name"));
    expect(screen.getByRole("button", { name: "Link" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Address and key" }));
    expect(field("link")).toBeNull();
    expect(field("origin")).toBe(screen.getByLabelText("Address"));
    fireEvent.change(field("origin")!, { target: { value: "https://studio.example.com" } });
    fireEvent.change(field("key")!, { target: { value: "tc_x.y" } });
    await press("Link");
    expect(made("remote.environments.add")).toEqual([{ on: "local", method: "remote.environments.add", params: { url: "https://studio.example.com", key: "tc_x.y" } }]);
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it("signs in to a saved computer again, and says so when the link is another computer's", async () => {
    answers["remote.environments.pair"] = { id: "env_other", name: "Studio" };
    const onClose = vi.fn();
    render(<AddComputerDialog ask={{ way: "link", computer: "env_box" }} onClose={onClose} />);
    expect(title()).toBe("Sign in to the box again");
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("The box");
    fireEvent.click(screen.getByRole("button", { name: "Address and key" }));
    expect((field("origin") as HTMLInputElement).value).toBe("https://box.example.com");
    fireEvent.click(screen.getByRole("button", { name: "Sign-in link" }));
    fireEvent.change(field("link")!, { target: { value: "https://studio.example.com/pair#X" } });
    await press("Sign in");
    expect(await screen.findByText("That link is for another computer, Studio, which is now linked too.")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("using a setup link on this Mac", () => {
  it("asks the link of this Mac and shows who gives what", async () => {
    answers["devices.setup.peek"] = { giver: "Landon's MacBook", origin: "https://box.example.com", items: { accounts: true, lifeos: false, reader: false, folders: false }, expiresAt: Date.now() + 600_000 };
    render(<AddComputerDialog ask={{ way: "use-link" }} onClose={() => {}} />);
    fireEvent.change(document.querySelector("[data-setup-field]")!, { target: { value: "https://box.example.com/setup#v1.x.y" } });
    await press("Continue");
    expect(made("devices.setup.peek")).toEqual([{ on: "local", method: "devices.setup.peek", params: { link: "https://box.example.com/setup#v1.x.y" } }]);
    expect(await screen.findByText("Landon's MacBook")).toBeTruthy();
    expect(title()).toBe("Use a setup link on this Mac");
  });
});
