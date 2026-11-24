import { Words } from "../acts/ActParts";
import { GenericActView } from "../acts/GenericActView";
import { shown } from "../acts/kindRows";
import type { ActViewProps } from "../acts/registry";

/**
 * A held `msform.make` or `msform.publish` in the Outbox (docs/agents/work-msforms.md "The hold"): the form in words
 * as people will see it, which is what his press makes or collects: its title and description, each question with its
 * kind and options, who can answer and when, and for a make the folder it is made in. The host wrote those words from
 * the very form and settings the press checks, so they are shown whole and nothing else is; the ids and the digest
 * stay the host's. A payload with no words takes the generic view.
 */
export function View(props: ActViewProps) {
  const content = (props.item.payload as { content?: unknown } | null)?.content;
  if (typeof content !== "string" || !content.trim()) return <GenericActView {...props} />;
  return (
    <div data-slot="act-payload" className="flex min-w-0 flex-col">
      <Words>{shown(content)}</Words>
    </div>
  );
}
