// @vitest-environment jsdom
/** Settings → Mail: mail's settings in the page's own sections over work-kit's client, and the page when LifeOS is down. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MailClientProvider } from "work-kit/mail";
import { corpusSignatures, corpusThreads, createFixtureMailClient } from "work-kit/mail/fixtures";

const lifeos = vi.hoisted(() => ({
  state: { environmentId: "local", sector: null, client: null as unknown, state: "signed-out", withheld: undefined as true | undefined },
  status: { lifeos: { state: "signed-out" } } as { lifeos: { state: string } } | null,
  unanswered: false,
  reopen: vi.fn(async () => {}),
  refresh: vi.fn(async () => {}),
}));
vi.mock("../shell/lifeos", async (real) => ({
  sessionFailure: ((await real()) as typeof import("../shell/lifeos")).sessionFailure,
  lifeosHostName: ((await real()) as typeof import("../shell/lifeos")).lifeosHostName,
  useLifeosSession: () => lifeos.state,
  useLifeosStatus: () => lifeos.status,
  useLifeosUnanswered: () => lifeos.unanswered,
  reopenLifeos: lifeos.reopen,
  refreshLifeos: lifeos.refresh,
}));
const link = vi.hoisted(() => ({ transport: "open" }));
vi.mock("../../lib/connection", () => ({ useEnvironmentStatus: () => link, registry: { environment: () => ({ name: "the box" }), retry: vi.fn(), statusOf: () => link, subscribe: () => () => {} } }));

const requestSettings = vi.hoisted(() => vi.fn());
vi.mock("../../lib/monaco/debugTab", () => ({ requestSettings }));
// The sign-in dialog the line's press opens in place (its own chunk, DownSignIn.tsx).
vi.mock("../shell/settings", () => ({ SignInDialog: () => <div role="dialog" aria-label="Sign in to LifeOS" /> }));

const confirm = vi.hoisted(() => ({ answer: true, asked: [] as { title: string }[] }));
vi.mock("../../chrome/ConfirmDialog", async (original) => ({
  ...(await original<object>()),
  confirmAction: async (request: { title: string }) => {
    confirm.asked.push(request);
    return confirm.answer;
  },
}));
vi.mock("../../components/choice-select", async () => await import("../../components/choice-select-body"));
// The signature's editor is work-kit's, tested there: jsdom lays out no text for it.
vi.mock("work-kit/mail", async (original) => ({ ...(await original<object>()), MailEditor: () => <div data-editor="" /> }));
// The grants' row is Work's page's own, tested there (work/shell/WorkPageSends.dom.test.tsx).
vi.mock("../shell/WorkPageSends", () => ({ GrantsRow: () => null }));

const { MailSettingsBody, Section } = await import("./MailSettingsSection");

afterEach(cleanup);

/** The fixture client with its settings writes seen, and refused on asking. */
function watched(senders?: string[]) {
  const client = createFixtureMailClient({ write: async ({ run }) => run(), instant: true, threads: corpusThreads(), signatures: corpusSignatures, ...(senders ? { settings: { pictures: "ask" as const } } : {}) });
  const calls: [string, unknown][] = [];
  const box = { refuse: false };
  const real = client.useSettingsActions();
  const actions = Object.fromEntries(
    Object.entries(real).map(([name, act]) => [
      name,
      async (...args: unknown[]) => {
        calls.push([name, args[0]]);
        if (box.refuse) throw new Error("refused");
        return (act as (...a: unknown[]) => Promise<unknown>)(...args);
      },
    ]),
  ) as typeof real;
  return { client: Object.assign(Object.create(client), { useSettingsActions: () => actions, ...(senders ? { useImageSenders: () => senders } : {}) }) as typeof client, calls, box };
}

async function choose(trigger: HTMLElement, name: string) {
  await act(async () => fireEvent.click(trigger));
  const option = await screen.findByRole("option", { name });
  await act(async () => {
    fireEvent.pointerDown(option, { pointerType: "mouse" });
    fireEvent.click(option);
  });
}

describe("Settings → Mail", () => {
  it("draws mail's settings in the page's own sections and rows, named by the map, with no title of the kit's own", async () => {
    const { client } = watched();
    render(
      <MailClientProvider client={client}>
        <MailSettingsBody />
      </MailClientProvider>,
    );
    await waitFor(() => expect(screen.getByRole("region", { name: "Writing" })).toBeTruthy());
    for (const group of ["Writing", "Reading", "Signatures", "Accounts"]) expect(screen.getByRole("region", { name: group }).getAttribute("data-slot")).toBe("page-section");
    for (const id of ["mail.from", "mail.replies", "mail.undo", "mail.pictures", "mail.density", "mail.markRead", "mail.signatures", "mail.accounts"]) expect(document.querySelector(`[data-setting="${id}"]`), id).toBeTruthy();
    expect(screen.queryByText("Mail")).toBeNull();
    expect(document.querySelector("[data-mail-settings]")).toBeNull();
  });

  it("writes a change at once and puts it back with LifeOS's reason when refused", async () => {
    const { client, calls, box } = watched();
    render(
      <MailClientProvider client={client}>
        <MailSettingsBody />
      </MailClientProvider>,
    );
    const undo = await screen.findByRole("combobox", { name: "Undo send" });
    await choose(undo, "30 seconds");
    await waitFor(() => expect(calls).toContainEqual(["update", { undoSeconds: 30 }]));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Undo send" }).textContent).toContain("30 seconds"));
    box.refuse = true;
    await choose(screen.getByRole("combobox", { name: "Mark as read" }), "Never");
    const row = document.querySelector<HTMLElement>('[data-setting="mail.markRead"]')!;
    await waitFor(() => expect(row.querySelector(".text-destructive")?.textContent).toBeTruthy());
    expect(screen.getByRole("combobox", { name: "Mark as read" }).textContent).not.toContain("Never");
  });

  it("opens the senders whose pictures always show in a dialog while pictures ask, each removed at one press", async () => {
    const { client, calls } = watched(["news@purdue.edu", "events@cosmicgames.com"]);
    render(
      <MailClientProvider client={client}>
        <MailSettingsBody />
      </MailClientProvider>,
    );
    expect((await screen.findByText("2 senders")).closest('[data-setting="mail.senders"]')).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Pictures always show from" })));
    const dialog = await screen.findByRole("dialog");
    await act(async () => fireEvent.click(within(dialog).getAllByRole("button", { name: "Remove" })[0]!));
    expect(calls).toContainEqual(["disallowImages", "news@purdue.edu"]);
  });

  it("asks before deleting a signature, and deletes it only on Delete", async () => {
    const { client, calls } = watched();
    render(
      <MailClientProvider client={client}>
        <MailSettingsBody />
      </MailClientProvider>,
    );
    const first = corpusSignatures[0]!;
    await act(async () => fireEvent.click(await screen.findByRole("button", { name: `Signature ${first.name}` })));
    confirm.answer = false;
    await act(async () => fireEvent.click(await screen.findByRole("button", { name: "Delete…" })));
    expect(confirm.asked.at(-1)!.title).toBe(`Delete the signature “${first.name}”?`);
    expect(calls.some(([name]) => name === "removeSignature")).toBe(false);
    confirm.answer = true;
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Delete…" })));
    await waitFor(() => expect(calls).toContainEqual(["removeSignature", first.id]));
  });

  it("say signed out under the same heading, the computer named, with Sign in opening the sign-in dialog in place", async () => {
    render(<Section environmentId="local" />);
    const section = document.querySelector<HTMLElement>("[data-mail-down]")!;
    expect(screen.getByText("Not signed in to LifeOS on the box").textContent).toBe("Not signed in to LifeOS on the box");
    fireEvent.click(within(section).getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Sign in to LifeOS" })).toBeTruthy());
    expect(requestSettings).not.toHaveBeenCalled();
  });

  /** Sol round 2 P1: the signed-out line is for a host that says so; every other ended session says its own state. */
  const at = (state: string, status: string | null, withheld?: true) => {
    lifeos.state = { ...lifeos.state, state, withheld };
    lifeos.status = status ? { lifeos: { state: status } } : null;
  };
  afterEach(() => {
    at("signed-out", "signed-out");
    link.transport = "open";
    lifeos.unanswered = false;
  });

  it("say LifeOS did not answer in red with Retry, never signed out, when the host cannot reach it", () => {
    at("unreachable", "unreachable");
    render(<Section environmentId="local" />);
    expect(screen.queryByText(/^Not signed in to LifeOS/)).toBeNull();
    expect(screen.getByRole("alert").textContent).toBe("LifeOS did not answer the box");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(lifeos.reopen).toHaveBeenCalledWith("local", null);
  });

  it("say a JWT that went unanswered while the host says connected did not answer", () => {
    at("unreachable", "connected");
    render(<Section environmentId="local" />);
    expect(screen.getByRole("alert").textContent).toBe("LifeOS did not answer the box");
  });

  it("tell a computer the host keeps LifeOS from so, with no Sign in", () => {
    at("unreachable", "connected", true);
    render(<Section environmentId="local" />);
    expect(screen.getByText("This computer cannot read LifeOS through the box")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("draw bones while the host's status is on its way, and the host's name with Retry when it is not connected", () => {
    at("connecting", null);
    link.transport = "connecting";
    const first = render(<Section environmentId="local" />);
    expect(screen.getByLabelText("Loading")).toBeTruthy();
    expect(screen.queryByText(/^Not signed in to LifeOS/)).toBeNull();
    first.unmount();
    link.transport = "offline";
    render(<Section environmentId="local" />);
    expect(screen.getByText("The box is not connected")).toBeTruthy();
    // Council round 12 (the walk): Retry spins in place while the link tries; the line stays.
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.getByText("The box is not connected")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" }).querySelector("[data-busy]")).toBeTruthy();
  });

  /** Sol round 3 P1: a first status ask that timed out while the link stayed open is said, with Retry, never bones for good. */
  it("name the host that did not answer the status ask, in red with Retry that asks it again", () => {
    at("connecting", null);
    lifeos.unanswered = true;
    render(<Section environmentId="local" />);
    expect(screen.queryByLabelText("Loading")).toBeNull();
    expect(screen.getByRole("alert").textContent).toBe("The box did not answer");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(lifeos.refresh).toHaveBeenCalledWith("local");
  });

  /** Council round 6 (Opus P3): on Settings → Work the switch is on the page; a press to the same page moved nothing. */
  it("say Work off with no press on the Work page, where the switch is", () => {
    at("off", "off");
    render(<Section environmentId="local" />);
    expect(screen.getByText(/^Work is off on /)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("say a refused sign-in as refused, with Sign in, and a sign-in that waits with Show the code", () => {
    at("refused", "refused");
    const first = render(<Section environmentId="local" />);
    expect(screen.getByText("LifeOS refused the box's sign-in")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
    first.unmount();
    at("pairing", "pairing");
    render(<Section environmentId="local" />);
    expect(screen.getByText("The LifeOS sign-in on the box waits for your approval")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show the code" })).toBeTruthy();
  });
});
