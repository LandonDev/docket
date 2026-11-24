import { lazy, Suspense, useState, type ReactNode } from "react";
import { useLifeosStatus } from "./lifeos";
import { downAction, type DownPress } from "./lifeosDown";

/** The sign-in dialog Connections and the view frame open, in its own chunk: no reader's first paint carries it. */
const SignInDialog = lazy(() => import("./settings").then((m) => ({ default: m.SignInDialog })));

/** The LifeOS sign-in dialog for one host, on its live status: it shows the code, and closes once the host is signed in. */
export function SignInFor({ environmentId, onClose }: { environmentId: string; onClose: () => void }) {
  const status = useLifeosStatus(environmentId);
  if (!status) return null;
  return (
    <Suspense fallback={null}>
      <SignInDialog environmentId={environmentId} state={status.lifeos} onClose={onClose} />
    </Suspense>
  );
}

/**
 * The rule's press as a reader draws it (`downAction`), with the dialog Sign in and Show the code open in place: the
 * press does what it says, never a page where he must press again. The reader draws `dialog` where it likes.
 */
export function useDownAction(press: DownPress | null, environmentId: string, retry?: () => void | Promise<void>): { action: ReturnType<typeof downAction>; dialog: ReactNode } {
  const [open, setOpen] = useState(false);
  const action = downAction(press, retry, () => setOpen(true));
  return { action, dialog: open ? <SignInFor environmentId={environmentId} onClose={() => setOpen(false)} /> : null };
}
