// @vitest-environment jsdom
/** Mail's settings in Settings → Work: one of the page's sections, "Mail", with no second title of the kit's own. */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MailClientProvider } from "work-kit/mail";
import { corpusSignatures, corpusThreads, createFixtureMailClient } from "work-kit/mail/fixtures";

const lifeos = vi.hoisted(() => ({ state: { client: null as unknown, state: "signed-out" } }));
vi.mock("../shell/lifeos", () => ({ useLifeosSession: () => lifeos.state, sessionWaits: (s: { state: string }) => s.state === "connecting" }));

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
});
