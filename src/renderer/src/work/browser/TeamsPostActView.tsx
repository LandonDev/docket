import { useContext } from "react";
import { PlaceLine, PostedAs } from "../acts/ActParts";
import { UnderItsAct } from "../acts/underItsAct";
import { GenericActView } from "../acts/GenericActView";
import { shown } from "../acts/kindRows";
import type { ActViewProps } from "../acts/registry";

/**
 * A held `teams.post` in the Outbox (docs/agents/work-browser.md): the post as he will see it in Teams, under the chat
 * or channel it lands in. The detail's heading says Post in Teams, so the chat is said once, here; under a row that
 * already says it ("Post in Teams to Esports Staff: …", the summary list opened in place) the post stands alone. A
 * payload of any other shape (an older one with html, which is then what goes) takes the generic view.
 */
export function View(props: ActViewProps) {
  const named = useContext(UnderItsAct);
  const p = (props.item.payload ?? {}) as { chat?: unknown; text?: unknown; html?: unknown };
  if (typeof p !== "object" || p.html !== undefined || typeof p.chat !== "string" || !p.chat.trim() || typeof p.text !== "string" || !p.text.trim()) return <GenericActView {...props} />;
  return (
    <div data-slot="act-payload" className="flex min-w-0 flex-col gap-3">
      {named ? null : <PlaceLine>{p.chat}</PlaceLine>}
      <PostedAs>{shown(p.text)}</PostedAs>
    </div>
  );
}
