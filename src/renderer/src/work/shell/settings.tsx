import { useEffect, useEffectEvent, useRef, useState, type FormEvent } from "react";
import type { LifeosState, LifeosStatus } from "@shared/contract-work-lifeos";
import { ModalBody, ModalPanel, useClosingDialog } from "../../chrome/Modal";
import { Field } from "../../chrome/DialogField";
import { DialogFooter, ErrorLine } from "../../chrome/ConfirmDialog";
import { Region } from "../../components/bones";
import { BusyLabel, Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { registry } from "../../lib/connection";
import { nameInLine } from "../../lib/hostWords";
import { useLinkMay } from "../../lib/linkMay";
import { workErrorWords } from "../../lib/workErrorWords";
import { sessionFailure } from "./lifeos";

/**
 * A failure on these pages in his words, naming the computer: `workErrorWords` for a known fault, else the
 * page's own line for the act ("The box did not save the change."), never the link's text.
 */
function failureWords(err: unknown, host: string | undefined, act: string, write = false): string {
  const name = host ? nameInLine(host) : undefined;
  const Host = name ? name.charAt(0).toUpperCase() + name.slice(1) : "The host";
  return workErrorWords(err, { host: name, write }) || `${Host} ${act}.`;
}

/** A link's name as the rail gives it, or nothing for a host this window does not know. */
const hostOf = (environmentId: string): string | undefined => registry.environment(environmentId)?.name;

/** A sign-in code's line: 16px on 24px, its figures even. */
const CODE = "font-mono text-base font-medium leading-6 text-foreground tabular-nums";

/**
 * Sign in by pairing (the host polls for its token itself), or, on this
 * window's own host alone, with a device token made in LifeOS (`auth:mint`):
 * `work.lifeos.setToken` is local-only. The code is shown only to this window, an admin.
 */
export function SignInDialog({ environmentId, state, onClose }: { environmentId: string; state: LifeosState; onClose: () => void }) {
  const link = registry.linkOf(environmentId);
  // A token is pasted only into this window's own host: another host takes it over a remote link never, and /ui's
  // own link is a key's (`work.lifeos.setToken` is local-only), so the host's rule is asked too.
  const mayToken = useLinkMay(environmentId, "work.lifeos.setToken");
  const local = environmentId === registry.primaryEnvironmentId && mayToken;
  const [code, setCode] = useState<{ code: string; expiresAt: number } | null>(
    state.state === "pairing" && state.code ? { code: state.code, expiresAt: state.expiresAt } : null,
  );
  const [token, setToken] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The code's ask that failed takes the bones' place, with Retry asking the same computer again.
  const [codeError, setCodeError] = useState<string | null>(null);
  // A press that asks again (Retry, New code) is out: the row it was pressed on stays, the press spinning in place,
  // until the new code or the new cause replaces it.
  const [asking, setAsking] = useState(false);
  const mounted = useRef(true);
  const { root, closeThen } = useClosingDialog(onClose, pending);
  const [now, setNow] = useState(() => Date.now());

  const ask = (): Promise<void> =>
    link.request<{ code: string; expiresAt: number }>("work.lifeos.pairStart", {}).then(
      (answer) => {
        if (!mounted.current) return;
        setCode(answer);
        setCodeError(null);
      },
      (err: unknown) => {
        if (!mounted.current) return;
        // A code past its life is no code: the failure takes its place, with Retry, never the dead code beside New code.
        setCode((was) => (was && was.expiresAt <= Date.now() ? null : was));
        // The host's silence by the rule's words ("The box did not answer"); any other cause in Work's.
        const silent = err instanceof Error && (err.name === "TimeoutError" || err.name === "ConnectionLostError");
        setCodeError(silent ? sessionFailure("unanswered", false, hostOf(environmentId)) : failureWords(err, hostOf(environmentId), "did not start the sign-in"));
      },
    );
  const askAgain = (): void => {
    setAsking(true);
    void ask().finally(() => mounted.current && setAsking(false));
  };
  // The first ask, under the code's bone: once a dialog, a later ask is his press.
  const firstAsk = useEffectEvent(() => {
    if (!code) void ask();
  });
  useEffect(() => {
    mounted.current = true;
    firstAsk();
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  // The host finishes the pairing by itself: the status push closes the dialog.
  useEffect(() => {
    if (state.state === "connected") closeThen(onClose);
  }, [closeThen, onClose, state.state]);

  const cancel = (): void => {
    void link.request("work.lifeos.pairCancel", {}).catch(() => {});
    closeThen(onClose);
  };
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!token.trim() || pending) return;
    setPending(true);
    setError(null);
    try {
      await link.request<LifeosStatus>("work.lifeos.setToken", { token: token.trim() });
      setPending(false);
      closeThen(onClose);
    } catch (err) {
      setError(failureWords(err, hostOf(environmentId), "did not take the token", true));
      setPending(false);
    }
  };
  const left = code ? Math.max(0, Math.ceil((code.expiresAt - now) / 1000)) : 0;

  return (
    <Dialog {...root}>
      <ModalPanel onClose={cancel} busy={pending} title="Sign in to LifeOS" description="Approve this code in LifeOS, under Approve a sign-in." size="sm">
        <form onSubmit={(event) => void submit(event)}>
          <ModalBody>
            <div className="flex items-baseline justify-between gap-3">
              {code || !codeError ? (
                // The code's own 24px line from a sample while it is asked for: nothing moves when it lands.
                <Region loading={!code} label="Asking for a code" className="min-w-0" bones={<span data-code-bone className={CODE}>ABCD-1234</span>}>
                  {code ? <span className={CODE}>{code.code}</span> : null}
                </Region>
              ) : (
                // Bones are for an ask that is out: a failed one says so in the code's place, with Retry.
                <p role="alert" data-code-failed className="min-w-0 text-xs leading-6 text-pretty text-destructive">
                  {codeError}
                </p>
              )}
              {code && left > 0 ? (
                <span className="text-xs text-muted-foreground tabular-nums">{`${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`}</span>
              ) : code ? (
                // A code past its life asks the same computer for a new one, in the timer's place (the ask's effect).
                <Button variant="ghost" size="xs" className="-me-2 shrink-0" disabled={asking} onClick={askAgain}>
                  <BusyLabel busy={asking} label="New code" align="end" />
                </Button>
              ) : codeError ? (
                <Button variant="ghost" size="xs" className="-me-2 shrink-0" disabled={asking} onClick={askAgain}>
                  <BusyLabel busy={asking} label="Retry" align="end" />
                </Button>
              ) : null}
            </div>
            {local ? (
              <Field label="Or a device token">
                <Input value={token} onChange={(event) => setToken(event.target.value)} placeholder="lo_…" spellCheck={false} autoComplete="off" />
              </Field>
            ) : null}
            <ErrorLine error={error} />
          </ModalBody>
          <DialogFooter onCancel={cancel} confirmLabel={local ? "Sign in" : undefined} pending={pending} disabled={!token.trim()} />
        </form>
      </ModalPanel>
    </Dialog>
  );
}
