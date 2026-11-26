// bun run ui:preview src/renderer/src/aliax/views/stats.preview.tsx#StatsPreview
// StatsPreview gives the real chart frames fixed measurements. Tooltips need interaction.
import { useLayoutEffect, useRef, useState } from "react";
import type { ComponentProps } from "react";
import { StatsView } from "./stats";

export function StatsPreview(props: ComponentProps<typeof StatsView>) {
  const frame = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    const owner = frame.current;
    const readRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      if (owner?.contains(this) && this.classList.contains("recharts-responsive-container")) {
        const height = Number.parseInt(this.parentElement?.style.height ?? "", 10);
        return new DOMRect(0, 0, 300, height || 200);
      }
      return readRect.call(this);
    };
    setReady(true);
    return () => { Element.prototype.getBoundingClientRect = readRect; };
  }, []);
  return <div ref={frame} className="min-w-0">{ready ? <StatsView {...props} /> : null}</div>;
}
