import { useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * The project screens' page bar, drawn in the Work view's own 40px header
 * (docs/DESIGN.md "Project screens"). The kit hands its bar to the host
 * (`ProjectsKit.Bar`): here the way back takes the view's name's place and
 * the controls sit at the header's end, through two slots the header mounts
 * (`Title` and `Head` of the view's chunk). Portals, so the controls keep
 * the screens' own providers.
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
  // Until a screen's bar lands the slot is empty, and says the view's name itself. One weight, whatever the screen: the kit's own crumb is semibold.
  return <span ref={setTitle} data-projects-title className="flex min-w-0 items-center gap-1.5 font-medium text-foreground empty:before:content-['Projects'] [&_.font-semibold]:font-medium" />;
}

/** The header's end: the screen's own controls. The row is theirs, so they collapse by its width (`@container/bar`). */
export function BarControls() {
  return <div ref={setControls} data-projects-controls className="@container/bar flex min-w-0 flex-[1000] items-center justify-end gap-1" />;
}

export function Bar({ crumb, children }: { crumb: ReactNode | null; children: ReactNode }) {
  const at = useSlots();
  return (
    <>
      {at.title ? createPortal(crumb ?? "Projects", at.title) : null}
      {at.controls ? createPortal(children, at.controls) : null}
    </>
  );
}
