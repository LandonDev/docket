import { createRoot } from "react-dom/client";
import { MailClientProvider, MailKitProvider, MailSettings, opening, type ComposeState, type MailBox } from "work-kit/mail";
import { corpusOutbox, corpusSignatures, corpusThreads, createFixtureMailClient, generateThreads } from "work-kit/mail/fixtures";
import { Toaster } from "../../../components/ui/toaster";
import { changeScheme } from "../../../lib/placeScheme";
import { nameOrigins, tempcodeMailKit } from "../kit";
import { MailScreen, patch, type MailPage } from "../MailView";

/**
 * Mail on dummy mail, with no host and no sign-in: TempCode's own kit, frame
 * and stylesheet round work-kit's fixture client. `bun scripts/mail-preview.ts`
 * builds this page, serves it under the app's own page policy and drives it
 * in headless Chromium for the proofs and the review shots. It is not part of
 * the app: nothing imports it, and nothing here reaches LifeOS.
 *
 * The address sets the scene: `?theme=light`, `?pictures=ask|show|never`,
 * `?density=two`, `?threads=5000`, `?late=1` (a fake worker that answers
 * slowly, to show what a late picture does), `?box=trash`.
 * `window.__mail` moves it on from there.
 */

const params = new URLSearchParams(location.search);
const ID = "preview";

changeScheme(params.get("theme") === "light" ? "light" : "dark", true);

nameOrigins(() => ({ label: "Drafted in Overdue invoices, Nov 18", open: () => {} }));

const bulk = Number(params.get("threads") ?? 0);
const client = createFixtureMailClient({
  write: async ({ run }) => run(),
  instant: params.get("late") !== "1",
  threads: [...corpusThreads(), ...(bulk ? generateThreads(bulk) : [])],
  settings: { pictures: (params.get("pictures") as "ask" | "show" | "never" | null) ?? "show", density: params.get("density") === "two" ? "two" : "three" },
  signatures: corpusSignatures,
  outbox: corpusOutbox(),
});

// The dummy mail is made by now: what follows is Mail's own work, which the speed run times from here.
(window as unknown as { __mailBuiltAt: number }).__mailBuiltAt = performance.now();

declare global {
  interface Window {
    __mail: {
      /** Sets what the page shows: the open thread, the composer, the mailbox. */
      set: (next: Partial<MailPage>) => void;
      open: (threadId: string | null) => void;
      compose: (state: Omit<ComposeState, "key"> | null) => void;
      asked: () => readonly string[];
      /** A new mail lands at the head of the inbox, as a sync would bring it. */
      deliver: (id: string, subject: string) => void;
    };
  }
}

window.__mail = {
  set: (next) => patch(ID, next),
  open: (threadId) => patch(ID, { threadId }),
  compose: (state) => patch(ID, { compose: state ? opening(state) : null }),
  asked: () => client.asked(),
  deliver: (id, subject) => {
    const [like] = corpusThreads();
    if (like) client.deliver({ ...like, id, subject, needsMe: false, messages: like.messages.slice(-1).map((m) => ({ ...m, id: `${id}-1`, unread: true, sentAt: Date.now(), attachments: [] })) });
  },
};

const box = params.get("box") as MailBox | null;
if (box) patch(ID, { box });

const open = params.get("open");
if (open) patch(ID, { threadId: open });

createRoot(document.getElementById("root")!).render(
  <>
    <MailClientProvider client={client}>
      <MailKitProvider kit={tempcodeMailKit}>
        {params.get("page") === "settings" ? (
          <div data-mail-kit className="tc-mail h-screen overflow-x-hidden overflow-y-auto bg-background p-6 text-foreground">
            <MailSettings />
          </div>
        ) : (
          <div className="h-screen bg-background text-foreground">
            <MailScreen id={ID} onOpenTask={() => {}} />
          </div>
        )}
      </MailKitProvider>
    </MailClientProvider>
    <Toaster />
  </>,
);
