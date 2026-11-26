import type { MailWaiting } from "@shared/contract-work-mail";
import { Page, PageRow, PageSection } from "../../components/page";
import { registry, type Link } from "../../lib/connection";
import { WaitingRows } from "./WaitingSection";

/**
 * A Work workspace's Waiting on over one fixed host, for `bun run ui:preview
 * src/renderer/src/work/mail/WaitingSection.preview.tsx#WaitingPreview --props '{"state":"off"}'`:
 * `off` (as it ships), `on`, `lifeos` (LifeOS did not answer, with Retry), `signedout` (LifeOS signed out on the
 * host: the days' row says so in the shared LifeOS line's words), `dropped` (the days were read, then the host signed
 * out of LifeOS while the page was open: the row goes down, its last value with it, the switch stays), `loading`.
 * Rendered by nothing in the app.
 */

type State = "off" | "on" | "lifeos" | "signedout" | "dropped" | "loading" | "connecting";
let state: State = "off";

// The host's own words for each (src/main/server/work/mail/waiting.ts): one prefix for every cause.
const ANSWERS: Partial<Record<State, MailWaiting>> = {
  on: { days: 5, routine: true, routineId: "r1" },
  dropped: { days: 5, routine: true, routineId: "r1" },
  lifeos: { days: null, routine: false, error: "LifeOS did not answer: LifeOS is unreachable" },
  signedout: { days: null, routine: false, error: "LifeOS did not answer: This host is not signed in to LifeOS" },
  // The days read while signed out; the sign-in approved since, the host now connecting.
  connecting: { days: null, routine: false, error: "LifeOS did not answer: This host is not signed in to LifeOS" },
};
const answer = (): MailWaiting => ANSWERS[state] ?? { days: 3, routine: false };

const link = {
  environmentId: "local",
  profile: "local",
  connected: true,
  onOpen: () => () => {},
  onClose: () => () => {},
  onPush: () => () => {},
  request<T>(method: string): Promise<T> {
    if (state === "loading") return new Promise<T>(() => {});
    // The host's LifeOS status, which the section hears live.
    if (method === "work.lifeos.status") return Promise.resolve((state === "signedout" || state === "dropped" ? { lifeos: { state: "signed-out" }, keys: [] } : state === "connecting" ? { lifeos: { state: "connecting" }, keys: [] } : { lifeos: { state: "connected", ownerId: "landon", since: 1 }, keys: [] }) as T);
    return Promise.resolve(answer() as T);
  },
} as unknown as Link;
Object.assign(registry, { primary: () => link, linkOf: () => link, link: () => link });

const WS = { id: "ws", name: "Purdue Esports", path: "/home/work/Purdue Esports", kind: "work", sector: "purdue", createdAt: 1, environmentId: "local" } as never;

export function WaitingPreview({ state: s = "off" }: { state?: State }) {
  state = s;
  return (
    <Page title="Purdue Esports" description="Purdue, on this Mac">
      {/* The row before them on the real page, for its spacing. */}
      <PageSection title="Writing and mail">
        <PageRow title="Learn how I write from my sent mail" description="48 mails from landon@purdue.edu since Oct 19" />
        <WaitingRows key={s} workspace={WS} />
      </PageSection>
    </Page>
  );
}
