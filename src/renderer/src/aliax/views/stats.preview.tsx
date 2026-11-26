// bun run ui:preview src/renderer/src/aliax/views/stats.preview.tsx#StatsPreview
// StatsPreview gives the real chart frames fixed measurements (300px wide, which a day axis reads to space its
// dates, as a 400px window's charts are). Tooltips need interaction.
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
    // The frame's width reaches a day chart through a ResizeObserver, which jsdom lacks: report the same 300px.
    const Observer = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(private cb: ResizeObserverCallback) {}
      observe(el: Element): void {
        // The frame alone: recharts' own container keeps the measure above.
        if (owner?.contains(el) && el.hasAttribute("data-chart")) this.cb([{ target: el, contentRect: new DOMRect(0, 0, 300, 200) } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
    setReady(true);
    return () => {
      Element.prototype.getBoundingClientRect = readRect;
      globalThis.ResizeObserver = Observer;
    };
  }, []);
  return <div ref={frame} className="min-w-0">{ready ? <StatsView {...props} /> : null}</div>;
}
