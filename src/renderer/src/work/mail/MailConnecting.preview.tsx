// A preview page for `bun run ui:preview 'src/renderer/src/work/mail/MailConnecting.preview.tsx#MailConnecting'` (and
// #ChatConnecting): Mail while the box says its LifeOS is connecting. `MailConnecting`: the view frame's one named wait
// in the body's place, no press, the view's name over it. `ChatConnecting`: a Mail chat's cards on that host, the first
// holding the wait, the rest drawing nothing. Rendered by nothing in the app.
import { registry } from "../../lib/connection";
import { sessionStore } from "../../lib/tcserver/store";
import type { SessionMeta } from "../../lib/tcserver/types";
import { TranscriptSessionContext } from "../../surfaces/transcriptSession";
import { JOB, standUpView, ViewAt } from "../kit.preview";
import { resetLifeos, setLifeosStatus } from "../shell/lifeos";
import { MailOfferRow } from "./chat/OfferCard";

let ready = false;
/** The box's link open, its LifeOS on its way. */
function connecting(): void {
  if (ready) return;
  ready = true;
  standUpView("mail", {});
  resetLifeos();
  setLifeosStatus(JOB.environmentId, { lifeos: { state: "connecting" }, keys: [] });
  const open = { ...registry.statusOf(JOB.environmentId), transport: "open" } as ReturnType<typeof registry.statusOf>;
  Object.assign(registry, { statusOf: () => open, environment: (id: string) => ({ id, name: "The box" }) });
}

export function MailConnecting() {
  connecting();
  return <ViewAt view="mail" height={360} />;
}

const card = (id: string, offer: object) => <MailOfferRow key={id} block={{ id, role: "tool", tool: { status: "completed", detail: JSON.stringify({ mailOffer: offer }) } } as never} />;

export function ChatConnecting() {
  connecting();
  sessionStore.adopt({ id: "s1", environmentId: JOB.environmentId, status: "idle", archived: false, workspaceId: JOB.id, projectId: null, scope: "work", createdAt: 1, updatedAt: 1 } as SessionMeta, { created: true });
  return (
    <TranscriptSessionContext.Provider value="s1">
      <div className="flex w-[560px] flex-col gap-4 p-6">
        <p className="text-sm">Two things from Dana's mail:</p>
        {card("c-task", { task: { title: "Book the room" } })}
        {card("c-event", { event: { title: "Lunch with Dana", start: "2026-12-04T12:30:00" } })}
      </div>
    </TranscriptSessionContext.Provider>
  );
}
