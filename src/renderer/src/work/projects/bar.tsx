import { useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft } from "../../chrome/icons";
import { Button } from "../../components/ui/button";

/**
 * The project screens' page bar, drawn in the Work view's own 40px header
 * (docs/DESIGN.md "Project screens"). The kit hands its bar to the host
 * (`ProjectsKit.Bar`): here the way back takes the view's name's place and
 * the controls sit at the header's end, through two slots the header mounts
 * (`Title` and `Head` of the view's chunk). Portals, so the controls keep
 * the screens' own providers. The way back is TempCode's own, one shape on
 * every screen, drawn from what the kit says Back does (`back`, `here`).
 */

type Slots = { title: HTMLElement | null; controls: HTMLElement | null };
let slots: Slots = { title: null, controls: null };
const listeners = new Set<() => void>();
const set = (patch: Partial<Slots>): void => {
  slots = { ...slots, ...patch };
  for (const l of listeners) l();
};
const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
const useSlots = (): Slots => useSyncExternalStore(subscribe, () => slots);

const setTitle = (el: HTMLElement | null): void => set({ title: el });
const setControls = (el: HTMLElement | null): void => set({ controls: el });

/** The header's name: the way back when the screens stand inside a project, else "Projects". */
export function BarTitle() {
  // Until a screen's bar lands the slot is empty, and says the view's name itself.
  return <span ref={setTitle} data-projects-title className="flex min-w-0 items-center gap-1 font-medium text-foreground empty:before:content-['Projects']" />;
}

/** The header's end: the screen's own controls. The row is theirs, so they collapse by its width (`@container/bar`). */
export function BarControls() {
  return <div ref={setControls} data-projects-controls className="@container/bar flex min-w-0 flex-[1000] items-center justify-end gap-1" />;
}

/**
 * One way back on every screen (docs/DESIGN.md "Project screens"): a 24px arrow, then the name of
 * where it goes ("Projects", or the project a document was opened from), then what the screen adds
 * beside it (a task's key, "New project"). The list has none and says the view's name. The kit's
 * own `crumb`, a different shape on each screen, is not drawn.
 */
export function Bar({ back, here, children }: { crumb?: ReactNode | null; back?: { label?: string | undefined; run: () => void } | null | undefined; here?: ReactNode | undefined; children: ReactNode }) {
  const at = useSlots();
  const title = back ? (
    <>
      <Button type="button" variant="ghost" size="icon-xs" aria-label={back.label ? `Back to ${back.label}` : "Back"} className="-ms-1.5 shrink-0 text-muted-foreground" onClick={back.run}>
        <ArrowLeft />
      </Button>
      {back.label ? <span className="min-w-0 truncate">{back.label}</span> : null}
      {here ? <span className="min-w-0 truncate font-normal text-muted-foreground">{here}</span> : null}
    </>
  ) : (
    "Projects"
  );
  return (
    <>
      {at.title ? createPortal(title, at.title) : null}
      {at.controls ? createPortal(children, at.controls) : null}
    </>
  );
}
