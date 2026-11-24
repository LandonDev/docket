// @vitest-environment jsdom
/**
 * Mail coming back (docs/agents/work-return.md) on work-kit's fixture mail: the mail and the account a window before
 * this one left open again, and one that is gone since gives way to the list, quietly.
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const { MailClientProvider, MailKitProvider } = await import("work-kit/mail");
const { corpusThreads, createFixtureMailClient } = await import("work-kit/mail/fixtures");
const { MailScreen } = await import("./MailView");
const { pageOf, pages } = await import("./page");
const { tempcodeMailKit } = await import("./kit");
const { keepPlace } = await import("../shell/place");

const threads = corpusThreads();

beforeEach(() => {
  pages.clear();
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1280 });
  Element.prototype.scrollIntoView = () => undefined;
});
afterEach(cleanup);

async function mount(): Promise<void> {
  const client = createFixtureMailClient({ write: async ({ run }) => run(), instant: true, threads: corpusThreads() });
  render(
    <MailClientProvider client={client}>
      <MailKitProvider kit={tempcodeMailKit}>
        <MailScreen id="ws" onOpenTask={() => undefined} />
      </MailKitProvider>
    </MailClientProvider>,
  );
  await act(async () => {});
}

describe("Mail coming back", () => {
  it("opens the mail it was left on", async () => {
    keepPlace("ws", "mail", { box: "inbox", threadId: threads[0]!.id });
    await mount();
    expect(pageOf("ws").threadId).toBe(threads[0]!.id);
  });

  it("a mail deleted since leaves the reader empty, quietly", async () => {
    keepPlace("ws", "mail", { box: "inbox", threadId: "gone-since" });
    await mount();
    expect(pageOf("ws").threadId).toBeNull();
  });

  it("an account removed since shows every account's mail", async () => {
    keepPlace("ws", "mail", { account: "removed-account", box: "sent" });
    await mount();
    expect(pageOf("ws")).toMatchObject({ account: null, box: "sent" });
  });
});
