import type { MailWaiting } from "@shared/contract-work-mail";
import { Page, PageRow, PageSection } from "../../components/page";
import { registry, type Link } from "../../lib/connection";
import { WaitingSection } from "./WaitingSection";

/**
 * A Work workspace's Waiting on over one fixed host, for `bun run ui:preview
 * src/renderer/src/work/mail/WaitingSection.preview.tsx#WaitingPreview --props '{"state":"off"}'`:
 * `off` (as it ships), `on`, `lifeos` (LifeOS did not answer), `loading`.
 * Rendered by nothing in the app.
 */

type State = "off" | "on" | "lifeos" | "loading";
let state: State = "off";

const answer = (): MailWaiting =>
  state === "on" ? { days: 5, routine: true, routineId: "r1" } : state === "lifeos" ? { days: null, routine: false, error: "LifeOS did not answer: the box is unreachable" } : { days: 3, routine: false };

const link = {
  environmentId: "local",
  profile: "local",
  connected: true,
  onOpen: () => () => {},
  onClose: () => () => {},
  onPush: () => () => {},
  request<T>(): Promise<T> {
    return state === "loading" ? new Promise<T>(() => {}) : Promise.resolve(answer() as T);
  },
} as unknown as Link;
Object.assign(registry, { primary: () => link, linkOf: () => link, link: () => link });

const WS = { id: "ws", name: "Purdue Esports", path: "/home/work/Purdue Esports", kind: "work", sector: "purdue", createdAt: 1, environmentId: "local" } as never;

export function WaitingPreview({ state: s = "off" }: { state?: State }) {
  state = s;
  return (
    <Page title="Purdue Esports" description="A Work workspace">
      {/* The section before it on the real page, for its spacing. */}
      <PageSection title="Voice">
        <PageRow title="Read my sent mail for how I write" description="48 mails from landon@purdue.edu since Oct 19" />
      </PageSection>
      <WaitingSection key={s} workspace={WS} />
    </Page>
  );
}
