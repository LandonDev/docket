import { useEffect, useRef, useState, type ComponentProps } from "react";
import { BusyLabel, Button } from "../../components/ui/button";

/**
 * A press that fetches an older page of history: the button spins from the
 * press until the page lands (DESIGN "Loading and empty states": the button
 * clicked is the one that spins), so a slow link never asks for a second
 * press. A press while it spins sends nothing more. The busy state is the
 * button's own: one row holds it, never every row.
 */
export function LoadEarlierButton({
  onLoad,
  label,
  busyLabel = label,
  ...props
}: {
  onLoad: () => void | Promise<unknown>;
  label: string;
  busyLabel?: string;
} & Omit<ComponentProps<typeof Button>, "onClick" | "children">) {
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return (
    <Button
      {...props}
      aria-busy={busy || undefined}
      onClick={() => {
        if (busy) return;
        const page = onLoad();
        if (!page) return;
        setBusy(true);
        void page.then(
          () => mounted.current && setBusy(false),
          () => mounted.current && setBusy(false),
        );
      }}
    >
      <BusyLabel busy={busy} label={label} busyLabel={busyLabel} />
    </Button>
  );
}
