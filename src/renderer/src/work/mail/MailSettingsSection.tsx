import { ConvexProvider } from "convex/react";
import { MailClientProvider, MailKitProvider, MailSettings } from "work-kit/mail";
import "work-kit/mail/styles.css";
import "./mail.css";
import { PageEmpty, PageRowsSkeleton } from "../../components/page";
import { sessionWaits, useLifeosSession } from "../shell/lifeos";
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
  if (!lifeos.client) return sessionWaits(lifeos) ? <PageRowsSkeleton rows={3} /> : <PageEmpty>Sign in to LifeOS to set up Mail.</PageEmpty>;
  return (
    <ConvexProvider client={lifeos.client}>
      <MailClientProvider client={mailClientFor(environmentId, lifeos.client.url, "all")}>
        <MailKitProvider kit={tempcodeMailKit}>
          <div data-mail-kit className="tc-mail pt-8">
            <MailSettings className="max-w-none" />
          </div>
        </MailKitProvider>
      </MailClientProvider>
    </ConvexProvider>
  );
}
