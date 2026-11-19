import { useEffect, useState, type FormEvent } from "react";
import type { FrameioStatus } from "@shared/contract-work-frameio";
import { ModalPanel, useClosingDialog } from "../../chrome/Modal";
import { Field } from "../../chrome/DialogField";
import { DialogFooter, ErrorLine, errorText } from "../../chrome/ConfirmDialog";
import { PageRow, PageRowsSkeleton } from "../../components/page";
import { BusyLabel, Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import type { Link } from "../../lib/connection/link";
import { useHostRead } from "../../lib/connection/hostRead";
import { openUrl } from "../../lib/native";

/**
 * Settings → Work: Frame.io on one host (docs/agents/work-frameio.md,
 * "Sign-in"). Two rows: the sign-in, and the public address Frame.io's
 * webhooks come to. The page (milestone 8's) mounts it with the host's link;
 * it reads `work.frameio.status` and follows the `work.frameio` push.
 */

export function FrameioRows({ link }: { link: Link | null | undefined }) {
  const read = useHostRead(link, () => link!.request<FrameioStatus>("work.frameio.status", {}));
  const [status, setStatus] = useState<FrameioStatus | undefined>(undefined);
  useEffect(() => {
    if (!link) return;
    return link.onPush((push) => {
      if (push.push === "work.frameio") setStatus(push.status);
    });
  }, [link]);
  const shown = status ?? read.value;
  return (
    <FrameioRowsView
      status={shown}
      error={read.error}
      onRetry={read.retry}
      request={async <T,>(method: string, params: unknown) => {
        const answer = await link!.request<T>(method, params);
        if (answer && typeof answer === "object" && "signedIn" in answer) setStatus(answer as unknown as FrameioStatus);
        return answer;
      }}
    />
  );
}

type Request = <T = FrameioStatus>(method: string, params: unknown) => Promise<T>;

/** The rows as the host's answer leaves them. */
export function FrameioRowsView({ status, error, onRetry, request }: { status: FrameioStatus | undefined; error: string | null; onRetry: () => void; request: Request }) {
  const [dialog, setDialog] = useState<"signIn" | "address" | null>(null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  if (!status) {
    if (!error) return <PageRowsSkeleton rows={1} description control="button" />;
    return (
      <PageRow title="Frame.io" error={error}>
        <Button variant="ghost" size="sm" onClick={onRetry}>
          Retry
        </Button>
      </PageRow>
    );
  }
  const signOut = async (): Promise<void> => {
    setPending(true);
    setFailed(null);
    try {
      await request("work.frameio.signOut", {});
    } catch (err) {
      setFailed(errorText(err));
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      <PageRow title="Frame.io" description={status.user ? status.user.email ?? status.user.name : "Not signed in"} error={failed ?? status.error}>
        {status.signedIn ? (
          <Button variant="ghost" size="sm" disabled={pending} onClick={() => void signOut()}>
            <BusyLabel busy={pending} label="Sign out" />
          </Button>
        ) : (
          <Button variant="secondary" size="sm" onClick={() => setDialog("signIn")}>
            Sign in…
          </Button>
        )}
      </PageRow>
      {status.signedIn ? (
        <PageRow title="Frame.io webhooks" description={status.publicUrl ?? "Off"}>
          <Button variant="ghost" size="sm" onClick={() => setDialog("address")}>
            {status.publicUrl ? "Change…" : "Set address…"}
          </Button>
        </PageRow>
      ) : null}
      {dialog === "signIn" ? <SignInDialog status={status} request={request} onClose={() => setDialog(null)} /> : null}
      {dialog === "address" ? <AddressDialog status={status} request={request} onClose={() => setDialog(null)} /> : null}
    </>
  );
}

/**
 * Adobe's sign-in in two steps: the credential, then the address the
 * browser ended on. A browser on the host itself answers on its own and the
 * pushed status closes the dialog; on another machine the person pastes it.
 */
export function SignInDialog({ status, request, onClose }: { status: FrameioStatus; request: Request; onClose: () => void }) {
  const [clientId, setClientId] = useState(status.clientId ?? "");
  const [redirect, setRedirect] = useState(status.redirectUri);
  const [opened, setOpened] = useState(false);
  const [address, setAddress] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { root, closeThen } = useClosingDialog(onClose, pending);
  useEffect(() => {
    if (opened && status.signedIn) closeThen(onClose);
  }, [closeThen, onClose, opened, status.signedIn]);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      if (!opened) {
        const { url } = await request<{ url: string }>("work.frameio.signIn", { clientId: clientId.trim(), redirectUri: redirect.trim() });
        await openUrl(url);
        setOpened(true);
        setPending(false);
      } else {
        await request("work.frameio.finish", { url: address.trim() });
        setPending(false);
        closeThen(onClose);
      }
    } catch (err) {
      setError(errorText(err));
      setPending(false);
    }
  };

  return (
    <Dialog {...root}>
      <ModalPanel onClose={() => closeThen(onClose)} busy={pending} title="Sign in to Frame.io" description={opened ? "Finish in the browser. If it ends on a page that does not load, paste its address here." : "With the OAuth Native App credential from the Adobe Developer Console."} size="sm">
        <form onSubmit={(event) => void submit(event)}>
          <div className="flex flex-col gap-4 px-5 py-4">
            {opened ? (
              <Field label="Address the sign-in ended on">
                <Input value={address} onChange={(event) => setAddress(event.target.value)} placeholder="http://127.0.0.1:7697/frameio/callback?code=…" spellCheck={false} autoComplete="off" autoFocus />
              </Field>
            ) : (
              <>
                <Field label="Client ID">
                  <Input value={clientId} onChange={(event) => setClientId(event.target.value)} spellCheck={false} autoComplete="off" autoFocus />
                </Field>
                <Field label="Redirect address">
                  <Input value={redirect} onChange={(event) => setRedirect(event.target.value)} spellCheck={false} autoComplete="off" />
                </Field>
              </>
            )}
            <ErrorLine error={error} />
          </div>
          <DialogFooter onCancel={() => closeThen(onClose)} confirmLabel={opened ? "Sign in" : "Open Adobe sign-in"} pending={pending} disabled={opened ? !address.trim() : clientId.trim().length < 8 || !redirect.trim()} />
        </form>
      </ModalPanel>
    </Dialog>
  );
}

/** The https address the tunnel gives this host; Frame.io sends its webhooks there. */
function AddressDialog({ status, request, onClose }: { status: FrameioStatus; request: Request; onClose: () => void }) {
  const [url, setUrl] = useState(status.publicUrl ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { root, closeThen } = useClosingDialog(onClose, pending);
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await request("work.frameio.setPublicUrl", { url: url.trim() || null });
      setPending(false);
      closeThen(onClose);
    } catch (err) {
      setError(errorText(err));
      setPending(false);
    }
  };
  return (
    <Dialog {...root}>
      <ModalPanel onClose={() => closeThen(onClose)} busy={pending} title="Frame.io webhooks" description="The public https address that reaches this host. Leave it empty to turn webhooks off." size="sm">
        <form onSubmit={(event) => void submit(event)}>
          <div className="flex flex-col gap-4 px-5 py-4">
            <Field label="Address">
              <Input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://" spellCheck={false} autoComplete="off" autoFocus />
            </Field>
            <ErrorLine error={error} />
          </div>
          <DialogFooter onCancel={() => closeThen(onClose)} confirmLabel="Save" pending={pending} disabled={!!url.trim() && !url.trim().startsWith("https://")} />
        </form>
      </ModalPanel>
    </Dialog>
  );
}
