// @vitest-environment jsdom
/** Mail's settings in Settings → Work: one of the page's sections, "Mail", with no second title of the kit's own. */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
vi.mock("../../lib/connection", () => ({ useEnvironmentStatus: () => link, registry: { environment: () => ({ name: "the box" }), retry: vi.fn() } }));

const requestSettings = vi.hoisted(() => vi.fn());
vi.mock("../../lib/monaco/debugTab", () => ({ requestSettings }));

const { MailSettingsBody, Section } = await import("./MailSettingsSection");

afterEach(cleanup);

describe("Mail's settings on the Work settings page", () => {
  it("are one section headed Mail, the kit's groups inside it and no title of the kit's own", async () => {
    const client = createFixtureMailClient({ write: async ({ run }) => run(), instant: true, threads: corpusThreads(), signatures: corpusSignatures });
    render(
      <MailClientProvider client={client}>
        <MailSettingsBody />
      </MailClientProvider>,
    );
    await waitFor(() => expect(screen.getByText("Writing")).toBeTruthy());
    const section = screen.getByRole("region", { name: "Mail" });
    expect(section.getAttribute("data-slot")).toBe("page-section");
    // The page's section heading is the one "Mail" on the page.
    expect(screen.getAllByText("Mail")).toHaveLength(1);
    expect(section.querySelector("[data-mail-settings]")).not.toBeNull();
    for (const group of ["Writing", "Reading", "Signatures", "Accounts"]) expect(section.contains(screen.getByText(group))).toBe(true);
  });

  it("say signed out under the same heading, with Sign in opening Settings → Connections", () => {
    render(<Section environmentId="local" />);
    const section = screen.getByRole("region", { name: "Mail" });
    expect(screen.getByText("Not signed in to LifeOS").textContent).toBe("Not signed in to LifeOS");
    fireEvent.click(within(section).getByRole("button", { name: "Sign in" }));
    expect(requestSettings).toHaveBeenCalledWith("connections");
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
    expect(screen.queryByText("Not signed in to LifeOS")).toBeNull();
    expect(screen.getByRole("alert").textContent).toBe("LifeOS did not answer");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(lifeos.reopen).toHaveBeenCalledWith("local", null);
  });

  it("say a JWT that went unanswered while the host says connected did not answer", () => {
    at("unreachable", "connected");
    render(<Section environmentId="local" />);
    expect(screen.getByRole("alert").textContent).toBe("LifeOS did not answer");
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
    expect(screen.queryByText("Not signed in to LifeOS")).toBeNull();
    first.unmount();
    link.transport = "offline";
    render(<Section environmentId="local" />);
    expect(screen.getByText("The box is not connected")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
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
    expect(screen.getByText("The LifeOS sign-in waits for your approval")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show the code" })).toBeTruthy();
  });
});
