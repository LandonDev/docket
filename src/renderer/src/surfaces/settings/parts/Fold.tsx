import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronRight } from "../../../chrome/icons";
import { Collapsible, CollapsibleContent, CollapsibleTrigger, DISCLOSURE_CHEVRON } from "../../../components/ui/collapsible";
import { cn } from "../../../lib/cn";
import { FOLD_OPEN_EVENT } from "../../../lib/settings/reveal";

/**
 * The rarely touched rows of a page, folded under one line ("Advanced"): the house disclosure, its heading in a
 * section heading's type so the page reads as sections. Its rows stay mounted while shut, so a row asked for by
 * search is found and opens the fold it sits in (lib/settings/reveal.ts).
 */
export function Fold({ label, defaultOpen = false, children }: { label: string; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const onOpen = (): void => setOpen(true);
    element.addEventListener(FOLD_OPEN_EVENT, onOpen);
    return () => element.removeEventListener(FOLD_OPEN_EVENT, onOpen);
  }, []);
  return (
    <Collapsible ref={root} data-fold="" open={open} onOpenChange={setOpen} className="min-w-0">
      <CollapsibleTrigger className="-mx-1 flex h-5 items-center gap-1 rounded-sm px-1 text-xs font-medium text-muted-foreground focus-ring">
        <ChevronRight className={cn("size-3", DISCLOSURE_CHEVRON, open && "rotate-90")} />
        {label}
      </CollapsibleTrigger>
      <CollapsibleContent keepMounted>
        <div className="mt-2 flex flex-col">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}
