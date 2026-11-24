import type { ReactNode } from "react";
import { X } from "../../chrome/icons";
import { Button } from "../../components/ui/button";
import { useSetupLink, type UseSetupLinkProps } from "./UseSetupLink";

/**
 * The computer's setup screens for `bun run ui:preview
 * src/renderer/src/surfaces/setup/UseSetupLink.preview.tsx#SetupLinkPreview`
 * (fixtures beside it). A dialog draws in a portal a static page cannot hold,
 * so each is drawn in the Modal's own box (chrome/Modal.tsx) around its real
 * body. Rendered by nothing in the app.
 */

/** The Modal's panel (chrome/Modal.tsx ModalPanel at `sm`), around a dialog's real body. */
export function ModalBox({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="grid place-items-center bg-background p-8">
      <div className="flex w-full max-w-md flex-col overflow-hidden rounded-2xl bg-popover text-sm leading-[22px] text-popover-foreground shadow-overlay ring-1 ring-border">
        <header className="flex shrink-0 items-start gap-2 px-5 pt-5">
          <div className="min-w-0 flex-1">
            <h2 className="text-base leading-6 font-semibold tracking-[-0.01em] text-balance">{title}</h2>
          </div>
          <Button variant="ghost" size="icon-sm" aria-label="Close" className="-me-1 -mt-0.5 text-muted-foreground">
            <X />
          </Button>
        </header>
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      </div>
    </div>
  );
}

export function SetupLinkPreview(props: UseSetupLinkProps) {
  const { title, body } = useSetupLink(props);
  return <ModalBox title={title}>{body}</ModalBox>;
}
