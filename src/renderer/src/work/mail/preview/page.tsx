import { createRoot } from "react-dom/client";
import { MailClientProvider, MailKitProvider, opening, type ComposeState } from "work-kit/mail";
import { corpusThreads, createFixtureMailClient, generateThreads } from "work-kit/mail/fixtures";
import { Toaster } from "../../../components/ui/toaster";
import { applyThemePreference, saveThemePreference } from "../../../lib/appearance";
import { tempcodeMailKit } from "../kit";
import { MailScreen, patch, type MailPage } from "../MailView";

/**
 * Mail on dummy mail, with no host and no sign-in: TempCode's own kit, frame
 * and stylesheet round work-kit's fixture client. `bun scripts/mail-preview.ts`
 * builds this page, serves it under the app's own page policy and drives it
 * in headless Chromium for the proofs and the review shots. It is not part of
 * the app: nothing imports it, and nothing here reaches LifeOS.
 *
 * The address sets the scene: `?theme=light`, `?pictures=ask|show|never`,
 * `?threads=5000`, `?late=1` (a fake worker that answers slowly, to show what
 * a late picture does). `window.__mail` moves it on from there.
 */

const params = new URLSearchParams(location.search);
const ID = "preview";

const theme = params.get("theme") === "light" ? "light" : "dark";
saveThemePreference(theme);
applyThemePreference(theme);

const bulk = Number(params.get("threads") ?? 0);
const client = createFixtureMailClient({
  write: async ({ run }) => run(),
  instant: params.get("late") !== "1",
  threads: [...corpusThreads(), ...(bulk ? generateThreads(bulk) : [])],
  settings: { pictures: (params.get("pictures") as "ask" | "show" | "never" | null) ?? "show" },
});

declare global {
  interface Window {
    __mail: {
      /** Sets what the page shows: the open thread, the composer, the mailbox. */
      set: (next: Partial<MailPage>) => void;
      open: (threadId: string | null) => void;
      compose: (state: Omit<ComposeState, "key"> | null) => void;
      asked: () => readonly string[];
    };
  }
}

window.__mail = {
  set: (next) => patch(ID, next),
  open: (threadId) => patch(ID, { threadId }),
  compose: (state) => patch(ID, { compose: state ? opening(state) : null }),
  asked: () => client.asked(),
};

const open = params.get("open");
if (open) patch(ID, { threadId: open });

createRoot(document.getElementById("root")!).render(
  <>
    <MailClientProvider client={client}>
      <MailKitProvider kit={tempcodeMailKit}>
        <div className="h-screen bg-background text-foreground">
          <MailScreen id={ID} onOpenTask={() => {}} />
        </div>
      </MailKitProvider>
    </MailClientProvider>
    <Toaster />
  </>,
);
