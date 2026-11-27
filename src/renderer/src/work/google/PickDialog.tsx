import { HostLinkLine, useHostLinkDown } from "../shell/hostLinkDown";
import { useAccountReach } from "./accountReach";
import { useEffect, useState } from "react";
import type { GoogleAccounts, GooglePicked } from "@shared/contract-work-google";
import { DialogFooter, ErrorLine } from "../../chrome/ConfirmDialog";
import { Modal, ModalBody, useModalClose } from "../../chrome/Modal";
import { Region } from "../../components/bones";
import { registry } from "../../lib/connection";
import { sayError } from "../canvas/frame";
import { AccountRow, AccountRowSample } from "./AccountRow";

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
  const pickerHost = registry.primaryEnvironmentId;
  const accountsReach = useAccountReach(pickerHost);
  const destinationDown = useHostLinkDown(env === pickerHost ? null : env);
  const [accounts, setAccounts] = useState<GoogleAccounts | null>(null);
  const [account, setAccount] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (accountsReach.held) return;
    let live = true;
    setError(null);
    // The Picker runs here, in this computer's browser: its own host is asked.
    registry
      .linkOf(pickerHost)
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
  }, [pickerHost, accountsReach.held]);

  const ready = accounts?.accounts.filter((a) => a.files) ?? [];
  const checkingEmpty = accountsReach.checking && ready.length === 0;
  const blocked = checkingEmpty ? null : accounts && !accounts.picker ? "This computer does not know LifeOS's Google client yet." : accounts && !ready.length ? "No Google account has allowed Drive files yet. Reconnect one in LifeOS." : null;

  // The dialog goes as the Picker comes up: the choosing happens in the browser, and nothing here waits on it.
  const run = (): void => {
    if (!account || accountsReach.held || destinationDown) return;
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
        {/* With no account to pick from, one muted line says what is missing, never an empty select. */}
        <Region loading={!accountsReach.held && !destinationDown && !blocked && !(accounts && !checkingEmpty) && !error} label="Loading accounts" bones={<AccountRowSample />}>
          {accountsReach.held ? accountsReach.line : destinationDown ? <HostLinkLine word={destinationDown} retryHost={env} /> : blocked ? (
            <p className="text-[13px] leading-5 text-muted-foreground">{blocked}</p>
          ) : accounts && !checkingEmpty ? (
            <AccountRow accounts={ready.map((a) => a.account)} value={account} onChange={setAccount} />
          ) : null}
        </Region>
        <ErrorLine error={accountsReach.held || destinationDown ? null : error} />
      </ModalBody>
      <DialogFooter onCancel={onClose} {...(blocked ? {} : { confirmLabel: "Choose files", disabled: !account || accountsReach.held || !!destinationDown })} />
    </form>
  );
}
