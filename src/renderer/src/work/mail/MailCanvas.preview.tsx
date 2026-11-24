// A preview page for `bun run ui:preview src/renderer/src/work/mail/MailCanvas.preview.tsx#MailCanvasPreview --props '{"state":"withheld"}'`:
// a held mail draft alone in the canvas pane while its LifeOS session is down. States: `withheld` (a computer the box
// keeps its LifeOS session from: said once, muted, no press) and `silent` (the box did not answer its LifeOS status: the
// state line in red with Retry, the draft kept in LifeOS). Rendered by nothing in the app.
import type { CanvasBodyProps } from "../canvas/kind";
import { asGivenComputer, CanvasKindAt } from "../kit.preview";
import { registry } from "../../lib/connection";
import { setLifeosStatus, setLifeosUnanswered } from "../shell/lifeos";
import { Body } from "./MailCanvas";

type State = "withheld" | "silent";

/** The draft the agent made, as the item names it in LifeOS's outbox. */
const parts = { Body: (props: CanvasBodyProps) => <Body {...props} source={{ at: "lifeos", table: "outbox", id: "ob_1" }} /> };

let ready = false;

export function MailCanvasPreview({ state = "withheld" }: { state?: State }) {
  if (!ready) {
    ready = true;
    if (state === "withheld") {
      // His laptop as a given computer: the box answers, but never hands its key a LifeOS session.
      asGivenComputer({ on: ["local"] });
      setLifeosStatus("local", { lifeos: { state: "connected", ownerId: "owner", since: 0 }, keys: [] });
    } else {
      setLifeosUnanswered("local");
      const open = { ...registry.statusOf("local"), transport: "open" } as ReturnType<typeof registry.statusOf>;
      Object.assign(registry, { statusOf: () => open, environment: (id: string) => ({ id, name: "The box" }) });
    }
  }
  return <CanvasKindAt id={`mail-${state}`} kind="mail" title="Re: Invoice 1042" parts={parts} height={320} />;
}
