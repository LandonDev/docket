// @vitest-environment jsdom
/** Mail's settings in Settings → Work: one of the page's sections, "Mail", with no second title of the kit's own. */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MailClientProvider } from "work-kit/mail";
import { corpusSignatures, corpusThreads, createFixtureMailClient } from "work-kit/mail/fixtures";

const lifeos = vi.hoisted(() => ({ state: { client: null as unknown, state: "signed-out" } }));
vi.mock("../shell/lifeos", () => ({ useLifeosSession: () => lifeos.state, sessionWaits: (s: { state: string }) => s.state === "connecting" }));

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

  it("say signed out under the same heading, with no period", () => {
    render(<Section environmentId="local" />);
    expect(screen.getByRole("region", { name: "Mail" }).textContent).toContain("Sign in to LifeOS to set up Mail");
    expect(screen.getByText("Sign in to LifeOS to set up Mail").textContent).toBe("Sign in to LifeOS to set up Mail");
  });
});
