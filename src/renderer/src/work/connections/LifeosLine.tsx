import { useState, type ReactNode } from "react";
import { PageEmpty, PageError } from "../../components/page";
import { BusyLabel, Button } from "../../components/ui/button";
import { registry, useEnvironmentStatus } from "../../lib/connection";
import { useDownPress } from "../shell/lifeosDown";
import { useDownAction } from "../shell/DownSignIn";
import { HostLine } from "../shell/DownLine";
import { retryLink } from "../shell/linkRetry";
import { lifeosHostName, refreshLifeos, reopenLifeos, sessionFailure, useLifeosStatus, useLifeosUnanswered, type LifeosSession } from "../shell/lifeos";

/**
 * A settings section that needs LifeOS while it has no session (docs/DESIGN.md "One name a thing"): the bones while
 * the host's status or the session's first JWT is on its way, else one line that says the state the host answered,
 * in the view frame's words (`sessionFailure`), with the press that can help at its end (`useDownPress`). "Not signed
 * in to LifeOS on the box" (or the refused sign-in) with Sign in, and a sign-in that waits with Show the code, each
 * opening the sign-in dialog in place where this window may sign the host in, else who can; "LifeOS did not answer the
 * box" in red with Retry; a host never heard from with its name and Retry; a host whose link is open but whose status
 * or session ask went unanswered, "<host> did not answer" in red with Retry; a computer the host keeps LifeOS from with no press; Work off
 * with a press to Settings → Work, the switch, where this window may turn it on (named "Work", the section it opens:
 * the line is in Settings already), else who can. `onWorkPage`: the line is on Settings → Work, the switch is on the
 * page, and Work off has no press. While the host says its LifeOS is still connecting, the named wait, "LifeOS is
 * still connecting on the box", with no press (`HostLine`), in place of the section's bones.
 * The line in `PageError`'s shape, so the 28px press overhangs the 16px line evenly.
 */
export function LifeosLine({ session, waiting, onWorkPage = false }: { session: Pick<LifeosSession, "environmentId" | "sector" | "state" | "withheld" | "unanswered">; waiting: ReactNode; onWorkPage?: boolean }) {
  const { environmentId, sector } = session;
  const status = useLifeosStatus(environmentId);
  const link = useEnvironmentStatus(environmentId);
  const unanswered = useLifeosUnanswered(environmentId);
  const [busy, setBusy] = useState(false);
  const state = status?.lifeos.state ?? null;
  // His Retry on "not connected" keeps the line, spinning, while the link tries (`retryLink`), never bones under it.
  const [linkRetrying, setLinkRetrying] = useState(false);
  const away = state === null && ((link.transport !== "open" && link.transport !== "connecting" && link.transport !== "reconnecting") || linkRetrying);
  const name = registry.environment(environmentId)?.name ?? "This host";
  const host = name.charAt(0).toUpperCase() + name.slice(1);
  // The computer named mid-line as the views name it ("Work is off on the box"), "this host" for one the registry does not know.
  const named = lifeosHostName(environmentId);
  // The session's own state counts too: its JWT can be refused or go unanswered while the host says connected.
  const signedOut = [state, session.state].find((s) => s === "signed-out" || s === "refused");
  // The rule's press for Work off and a sign-in (`useDownPress`): made only where this window may, else who can.
  const down = state === "off" ? "off" : state === "pairing" ? "pairing" : (signedOut ?? null);
  const { press, elsewhere } = useDownPress(down, environmentId);
  const { action, dialog } = useDownAction(press, environmentId);
  // A Retry that is not answered either leaves the line as it is: it says so already.
  const retryWith = (ask: () => Promise<void>) => (): void => {
    setBusy(true);
    void ask()
      .catch(() => {})
      .finally(() => setBusy(false));
  };
  if (away)
    return (
      <Line
        words={`${host} is not connected`}
        press={{
          label: "Retry",
          busy: linkRetrying,
          onClick: () => {
            setLinkRetrying(true);
            void retryLink(environmentId).finally(() => setLinkRetrying(false));
          },
        }}
      />
    );
  // The link is open but the status ask went unanswered: nothing asks again until the link reopens, so no bones.
  if (state === null && unanswered) return <Failed words={`${host} did not answer`} busy={busy} onRetry={retryWith(() => refreshLifeos(environmentId))} />;
  // Work off: on Settings → Work the switch is on the page, and says who can change it, so the line has neither press
  // nor note; elsewhere in Settings the press names the section it opens.
  if (state === "off" && onWorkPage) return <Line words={sessionFailure("off", false, named)} />;
  if (state === "off") return <Line words={sessionFailure("off", false, named)} note={elsewhere} press={action ? { label: "Work", onClick: action.run } : undefined} />;
  if (session.withheld) return <Line words={sessionFailure(session.state, true, named)} />;
  if (signedOut || state === "pairing")
    return (
      <>
        <Line words={sessionFailure(signedOut ?? "pairing", false, named)} note={elsewhere} press={action ? { label: action.label, onClick: action.run } : undefined} />
        {dialog}
      </>
    );
  // The host's own silence on the session's ask is said by its name, as on the status ask; LifeOS's, with the host named.
  if (state === "unreachable" || session.state === "unreachable")
    return <Failed words={session.unanswered ? `${host} did not answer` : sessionFailure("unreachable", false, named)} busy={busy} onRetry={retryWith(() => reopenLifeos(environmentId, sector))} />;
  if (state === "connecting") return <HostLine live={{ environmentId, down: null, waits: true }} data-slot="lifeos-line" className="py-3 text-xs" />;
  return waiting;
}

function Failed({ words, busy, onRetry }: { words: string; busy: boolean; onRetry: () => void }) {
  return (
    <PageError
      action={
        <Button variant="ghost" size="sm" disabled={busy} onClick={onRetry}>
          <BusyLabel busy={busy} label="Retry" />
        </Button>
      }
    >
      {words}
    </PageError>
  );
}

function Line({ words, note, press }: { words: string; note?: string | null; press?: { label: string; onClick: () => void; busy?: boolean } | undefined }) {
  return (
    <div data-slot="lifeos-line" className="flex items-start gap-3 py-3">
      <PageEmpty className="min-w-0 flex-1 py-0">
        {words}
        {note ? <span className="block">{note}</span> : null}
      </PageEmpty>
      {press ? (
        <span className="-my-1.5 flex shrink-0">
          <Button variant="ghost" size="sm" disabled={press.busy} onClick={press.onClick}>
            <BusyLabel busy={!!press.busy} label={press.label} />
          </Button>
        </span>
      ) : null}
    </div>
  );
}
