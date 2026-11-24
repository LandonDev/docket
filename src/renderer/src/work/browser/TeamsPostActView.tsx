import { PlaceLine, PostedAs } from "../acts/ActParts";
import { GenericActView } from "../acts/GenericActView";
import { shown } from "../acts/kindRows";
import type { ActViewProps } from "../acts/registry";

/**
 * A held `teams.post` in the Outbox (docs/agents/work-browser.md): the post as he will see it in Teams, under the chat
 * or channel it lands in. The heading says Post in Teams, so the chat is said once, here. A payload of any other shape
 * (an older one with html, which is then what goes) takes the generic view.
 */
export function View(props: ActViewProps) {
  const p = (props.item.payload ?? {}) as { chat?: unknown; text?: unknown; html?: unknown };
  if (typeof p !== "object" || p.html !== undefined || typeof p.chat !== "string" || !p.chat.trim() || typeof p.text !== "string" || !p.text.trim()) return <GenericActView {...props} />;
  return (
    <div data-slot="act-payload" className="flex min-w-0 flex-col gap-3">
      <PlaceLine>{p.chat}</PlaceLine>
      <PostedAs>{shown(p.text)}</PostedAs>
    </div>
  );
}
