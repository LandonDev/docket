import { ConvexProvider } from "convex/react";
import { MailClientProvider, MailKitProvider, MailSettings } from "work-kit/mail";
import "work-kit/mail/styles.css";
import "./mail.css";
import { PageRowsSkeleton, PageSection } from "../../components/page";
import { LifeosLine } from "../connections/LifeosLine";
import { useLifeosSession } from "../shell/lifeos";
import { mailClientFor } from "./client";
import { tempcodeMailKit } from "./kit";

/**
 * Settings, Work, Mail (docs/agents/work-mail.md "Settings"): work-kit's one
 * settings screen, on the host's whole LifeOS session, since mail's settings,
 * its signatures and an account's choices belong to no one sector. LifeOS
 * keeps them, so LifeOS desktop and the phone read the same values.
 */
export function Section({ environmentId }: { environmentId: string }) {
  const lifeos = useLifeosSession(environmentId, null);
  if (!lifeos.client) return <PageSection title="Mail"><LifeosLine session={lifeos} waiting={<PageRowsSkeleton rows={3} />} /></PageSection>;
  return (
    <ConvexProvider client={lifeos.client}>
      <MailClientProvider client={mailClientFor(environmentId, lifeos.client.url, "all")}>
        <MailSettingsBody />
      </MailClientProvider>
    </ConvexProvider>
  );
}

/**
 * The settings under whatever mail client is round them (the mail preview's fixture client draws them in a page):
 * one of the page's sections, "Mail", with work-kit's groups (Writing, Reading, Signatures, Accounts) inside it on the
 * page's scale (mail.css `data-mail-settings`), and no title of the kit's own.
 */
export function MailSettingsBody() {
  return (
    <PageSection title="Mail">
      <MailKitProvider kit={tempcodeMailKit}>
        <div data-mail-kit data-mail-settings className="tc-mail">
          <MailSettings className="max-w-none" heading={false} />
        </div>
      </MailKitProvider>
    </PageSection>
  );
}
