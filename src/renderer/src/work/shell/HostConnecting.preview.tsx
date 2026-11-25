// A preview page for `bun run ui:preview src/renderer/src/work/shell/HostConnecting.preview.tsx#HostConnectingPreview --shot`:
// council round 12, the box saying its LifeOS is still connecting. A person's page keeps Back to People beside the
// wait; a held calendar reply and a held chat reply say the wait once in their reads' place; the Settings LifeOS line
// says it where it drew bones. Rendered by nothing in the app.
import { registry } from "../../lib/connection";
import { LifeosLine } from "../connections/LifeosLine";
import { View as CalendarAct } from "../agenda/CalendarActView";
import { View as ChatReply } from "../messages/ChatReplyAct";
import { setPlace } from "../people/PeopleView";
import { JOB, standUpView, ViewAt } from "../kit.preview";
import { setLifeosSession, setLifeosStatus } from "./lifeos";

const REPLY = { id: "op1", kind: "accept", eventId: "ev1", account: "landon@purdue.edu" };
const CHAT = { kind: "chat.reply", sector: "purdue", payload: { chatId: "c1", source: "slack", chat: "Starboard Games", text: "Works for us, see you at 7." } };

let ready = false;

export function HostConnectingPreview() {
  if (!ready) {
    ready = true;
    standUpView("people", {});
    Object.assign(registry, { environment: (id: string) => ({ id, name: "The box" }) });
    setLifeosStatus("local", { lifeos: { state: "connecting" }, keys: [] } as never);
    setLifeosSession({ environmentId: "local", sector: JOB.sector, client: null, state: "connecting" });
    setLifeosSession({ environmentId: "local", sector: null, client: null, state: "connecting" });
    setPlace(JOB.id, { person: "p1" });
  }
  return (
    <div className="flex w-full max-w-[864px] flex-col gap-4">
      <ViewAt view="people" height={160} />
      <div className="rounded-lg border border-border bg-background p-4">
        <CalendarAct item={{ kind: "calendar.op", payload: REPLY, sector: "purdue" } as never} env="local" />
      </div>
      <div className="rounded-lg border border-border bg-background p-4">
        <ChatReply item={CHAT as never} env="local" />
      </div>
      <div className="rounded-lg border border-border bg-background px-4">
        <LifeosLine session={{ environmentId: "local", sector: null, client: null, state: "connecting" } as never} waiting={null} />
      </div>
    </div>
  );
}
