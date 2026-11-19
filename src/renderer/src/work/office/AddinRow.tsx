import { useEffect, useState } from "react";
import type { OfficeAddinCode, OfficeAddinKey } from "@shared/contract-work-office";
import { ModalPanel, useClosingDialog } from "../../chrome/Modal";
import { DialogFooter, ErrorLine, errorText } from "../../chrome/ConfirmDialog";
import { PageRow, PageRowsSkeleton } from "../../components/page";
import { BusyLabel, Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import type { Link } from "../../lib/connection/link";
import { useHostRead } from "../../lib/connection/hostRead";
import { timeAgo } from "../../lib/duration";

/**
 * Settings → Work, "Where it runs": our Office add-in on one host
 * (docs/agents/work-office.md "Pairing"). Pair… shows a short code the
 * add-in's pane takes once; each paired add-in is a row of its own with
 * Remove and no confirm, as a grant is.
 */

/** A paired add-in's line: connected now, or when it last was. */
export function addinLine(key: Pick<OfficeAddinKey, "live" | "seenAt">): string {
  if (key.live) return "Connected";
  if (key.seenAt === null) return "Not connected yet";
  const ago = timeAgo(key.seenAt);
  return ago === "now" ? "Last connected just now" : `Last connected ${ago} ago`;
}

export function AddinRow({ link, title }: { link: Link | null | undefined; title: string }) {
  const [round, setRound] = useState(0);
  const read = useHostRead(link, () => link!.request<{ keys: OfficeAddinKey[] }>("work.office.addin.list", {}), String(round));
  const [pairing, setPairing] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const keys = read.value?.keys;
  const reload = (): void => setRound((n) => n + 1);

  if (!keys) {
    if (!read.error) return <PageRowsSkeleton rows={1} description control="button" />;
    return (
      <PageRow title={title} error={read.error}>
        <Button variant="ghost" size="sm" onClick={read.retry}>
          Retry
        </Button>
      </PageRow>
    );
  }
  const remove = async (id: string): Promise<void> => {
    setRemoving(id);
    setError(null);
    try {
      await link!.request("work.office.addin.remove", { id });
      reload();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setRemoving(null);
    }
  };
  return (
    <>
      <PageRow title={title} description={keys.length ? undefined : "Not paired"} error={error ?? undefined}>
        <Button variant="secondary" size="sm" onClick={() => setPairing(true)}>
          Pair…
        </Button>
      </PageRow>
      {keys.map((key) => (
        <PageRow key={key.id} title={key.name} description={addinLine(key)}>
          <Button variant="ghost" size="sm" disabled={removing === key.id} onClick={() => void remove(key.id)}>
            <BusyLabel busy={removing === key.id} label="Remove" />
          </Button>
        </PageRow>
      ))}
      {pairing && link ? <PairDialog link={link} known={keys.length} onPaired={reload} onClose={() => setPairing(false)} /> : null}
    </>
  );
}

/** The code, its time left, and nothing to press: the dialog closes itself once the add-in has paired. */
function PairDialog({ link, known, onPaired, onClose }: { link: Link; known: number; onPaired: () => void; onClose: () => void }) {
  const [code, setCode] = useState<OfficeAddinCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const { root, closeThen } = useClosingDialog(onClose, false);

  useEffect(() => {
    let live = true;
    link.request<OfficeAddinCode>("work.office.addin.pair", {}).then(
      (answer) => live && setCode(answer),
      (err: unknown) => live && setError(errorText(err)),
    );
    return () => {
      live = false;
    };
  }, [link]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  // The add-in pairs with the host directly; a new key on the host means it is done.
  useEffect(() => {
    if (!code) return;
    let live = true;
    const timer = window.setInterval(() => {
      link.request<{ keys: OfficeAddinKey[] }>("work.office.addin.list", {}).then(
        (answer) => {
          if (!live || answer.keys.length <= known) return;
          onPaired();
          closeThen(onClose);
        },
        () => {},
      );
    }, 2000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [closeThen, code, known, link, onClose, onPaired]);

  const left = code ? Math.max(0, Math.ceil((code.expiresAt - now) / 1000)) : 0;
  const close = (): void => {
    onPaired();
    closeThen(onClose);
  };
  return (
    <Dialog {...root}>
      <ModalPanel onClose={close} title="Pair the Office add-in" description="Enter this code in the TempCode pane in Excel, Word or PowerPoint." size="sm">
        <div className="flex flex-col gap-4 px-5 py-4">
          <div className="flex items-baseline justify-between gap-3">
            {code ? (
              <span className="font-mono text-base font-medium leading-6 text-foreground tabular-nums">{code.code}</span>
            ) : error ? null : (
              <span className="text-xs text-muted-foreground">Asking for a code…</span>
            )}
            {code ? (
              <span className="text-xs text-muted-foreground tabular-nums">
                {left > 0 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : "Expired"}
              </span>
            ) : null}
          </div>
          <ErrorLine error={error} />
        </div>
        <DialogFooter confirmLabel="Done" onConfirm={close} />
      </ModalPanel>
    </Dialog>
  );
}
