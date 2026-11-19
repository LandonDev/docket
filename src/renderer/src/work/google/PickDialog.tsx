import { useEffect, useState } from "react";
import type { GoogleAccounts, GooglePicked } from "@shared/contract-work-google";
import { DialogFooter, ErrorLine } from "../../chrome/ConfirmDialog";
import { FieldRow } from "../../chrome/DialogField";
import { Modal, ModalBody, useModalClose } from "../../chrome/Modal";
import { ChoiceSelect } from "../../components/choice-select";
import { Skeleton } from "../../components/ui/skeleton";
import { registry } from "../../lib/connection";
import { sayError } from "../canvas/frame";

/**
 * Open from Google (docs/agents/work-google.md "Picking a file"): a dialog
 * with one choice, the account, as Export is. Choose files shows Google's
 * Picker in the browser on this computer; what he picks opens in the
 * thread's canvas on the thread's host. The dialog closes as the Picker
 * opens; a failure is a toast. The last account chosen is offered next time.
 */

const LAST = "work.google.account";
const PICK_WAIT_MS = 5.5 * 60_000;

export function PickDialog({ env, sessionId, onClose }: { env: string; sessionId: string; onClose(): void }) {
  return (
    <Modal onClose={onClose} title="Open from Google">
      <Body env={env} sessionId={sessionId} onClose={onClose} />
    </Modal>
  );
}

/** Google's Picker in this computer's browser, then each picked file opened on the thread's host; a failure is said once, as a toast. */
async function pickAndOpen(env: string, sessionId: string, account: string): Promise<void> {
  const { files } = await registry.linkOf(registry.primaryEnvironmentId).request<{ files: GooglePicked[] }>("work.google.pick", { account }, { timeoutMs: PICK_WAIT_MS });
  for (const f of files) await registry.linkOf(env).request<{ itemId: string }>("work.google.open", { sessionId, account, fileId: f.fileId });
}

function Body({ env, sessionId, onClose }: { env: string; sessionId: string; onClose(): void }) {
  const close = useModalClose();
  const [accounts, setAccounts] = useState<GoogleAccounts | null>(null);
  const [account, setAccount] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    // The Picker runs here, in this computer's browser: its own host is asked.
    registry
      .linkOf(registry.primaryEnvironmentId)
      .request<GoogleAccounts>("work.google.accounts", {})
      .then((got) => {
        if (!live) return;
        setAccounts(got);
        const ready = got.accounts.filter((a) => a.files).map((a) => a.account);
        const kept = localStorage.getItem(LAST);
        setAccount(kept && ready.includes(kept) ? kept : (ready[0] ?? ""));
      })
      .catch((err: unknown) => live && setError(err instanceof Error && err.message ? err.message : "Your Google accounts did not load"));
    return () => {
      live = false;
    };
  }, []);

  const ready = accounts?.accounts.filter((a) => a.files) ?? [];
  const blocked = accounts && !accounts.picker ? "This computer does not know LifeOS's Google client yet." : accounts && !ready.length ? "No Google account has allowed Drive files yet. Reconnect one in LifeOS." : null;

  // The dialog goes as the Picker comes up: the choosing happens in the browser, and nothing here waits on it.
  const run = (): void => {
    localStorage.setItem(LAST, account);
    const then = () => {
      onClose();
      void pickAndOpen(env, sessionId, account).catch((err: unknown) => sayError(err, "Nothing was opened"));
    };
    if (close) close(then);
    else then();
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        run();
      }}
    >
      <ModalBody>
        {accounts ? (
          <FieldRow label="Account" description={blocked ?? undefined}>
            <ChoiceSelect label="Account" value={account} options={ready.map((a) => ({ value: a.account, label: a.account }))} onChange={setAccount} />
          </FieldRow>
        ) : error ? null : (
          <div aria-busy className="flex h-8 items-center">
            <Skeleton className="h-3 w-1/2" />
          </div>
        )}
        <ErrorLine error={error} />
      </ModalBody>
      <DialogFooter onCancel={onClose} confirmLabel="Choose files" disabled={!account || !!blocked} />
    </form>
  );
}
