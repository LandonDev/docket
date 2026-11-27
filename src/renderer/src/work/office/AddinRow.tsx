import { useEffect, useState } from "react";
import type { OfficeAddinCode, OfficeAddinKey } from "@shared/contract-work-office";
import { ModalBody, ModalPanel, useClosingDialog } from "../../chrome/Modal";
import { confirmAction, DialogFooter, ErrorLine } from "../../chrome/ConfirmDialog";
import { Region } from "../../components/bones";
import { PageRow } from "../../components/page";
import { BusyLabel, Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { hostFailure } from "../../lib/hostFailure";
import type { Link } from "../../lib/connection/link";
import { useHostRead } from "../../lib/connection/hostRead";
import { timeAgo } from "../../lib/duration";
import { useKeptRetry } from "./keptRetry";

/**
 * Settings → Connections, Office: our Office add-in on one computer (docs/agents/work-office.md "Pairing"). Pair…
 * shows a short code the add-in's pane takes once; each paired add-in is a row of its own with Remove…, which asks
 * first: the add-in stops reaching Work until it is paired again.
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
  const kept = useKeptRetry(read.error, read.value === undefined && read.error === null);
  const reload = (): void => setRound((n) => n + 1);

  const remove = async (id: string, name: string): Promise<void> => {
    const sure = await confirmAction({ title: `Remove ${name}?`, body: "This add-in stops reaching Work until you pair it again.", action: "Remove", danger: true });
    if (!sure) return;
    setRemoving(id);
    setError(null);
    try {
      await link!.request("work.office.addin.remove", { id });
      reload();
    } catch (err) {
      setError(hostFailure(link!.environmentId, err, "did not remove the add-in", true));
    } finally {
      setRemoving(null);
    }
  };
  return (
    // Until the list answers, its rows drawn with none paired: the head row's shape, the title and Pair… at rest.
    <Region loading={!keys && !kept.error} label="Loading" bones={() => <AddinRows title={title} keys={NONE} error={null} removing={null} onPair={STILL} onRemove={STILL} />}>
      {keys ? (
        <>
          <AddinRows title={title} keys={keys} error={error} removing={removing} onPair={() => setPairing(true)} onRemove={(key) => void remove(key.id, key.name)} />
          {pairing && link ? <PairDialog link={link} known={keys.map((k) => k.id)} onPaired={reload} onClose={() => setPairing(false)} /> : null}
        </>
      ) : kept.error ? (
        <PageRow title={title} error={hostFailure(link!.environmentId, kept.error, "could not list the paired add-ins")}>
          <Button variant="ghost" size="sm" disabled={kept.retrying} onClick={() => kept.press(read.retry)}>
            <BusyLabel busy={kept.retrying} label="Retry" />
          </Button>
        </PageRow>
      ) : null}
    </Region>
  );
}

const NONE: OfficeAddinKey[] = [];
const STILL = (): void => undefined;

/** The add-in's head row with Pair…, then each paired add-in with Remove…; with no keys and no handlers, the list's bones. */
function AddinRows({
  title,
  keys,
  error,
  removing,
  onPair,
  onRemove,
}: {
  title: string;
  keys: readonly OfficeAddinKey[];
  error: string | null;
  removing: string | null;
  onPair: () => void;
  onRemove: (key: OfficeAddinKey) => void;
}) {
  return (
    <>
      <PageRow title={title} description={keys.length ? undefined : "Not paired"} error={error ?? undefined}>
        <Button variant="secondary" size="sm" onClick={onPair}>
          Pair…
        </Button>
      </PageRow>
      {keys.map((key) => (
        <PageRow key={key.id} title={key.name} description={addinLine(key)}>
          <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" disabled={removing === key.id} onClick={() => onRemove(key)}>
            <BusyLabel busy={removing === key.id} label="Remove…" />
          </Button>
        </PageRow>
      ))}
    </>
  );
}

/** The code, its time left, and nothing to press: the dialog closes itself once the add-in has paired. */
function PairDialog({ link, known, onPaired, onClose }: { link: Link; known: readonly string[]; onPaired: () => void; onClose: () => void }) {
  const [code, setCode] = useState<OfficeAddinCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const { root, closeThen } = useClosingDialog(onClose, false);

  useEffect(() => {
    let live = true;
    link.request<OfficeAddinCode>("work.office.addin.pair", {}).then(
      (answer) => live && setCode(answer),
      (err: unknown) => live && setError(hostFailure(link.environmentId, err, "did not give a code")),
    );
    return () => {
      live = false;
    };
  }, [link]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  // The add-in pairs with the host directly; a key the page did not know means it is done.
  useEffect(() => {
    if (!code) return;
    let live = true;
    const timer = window.setInterval(() => {
      link.request<{ keys: OfficeAddinKey[] }>("work.office.addin.list", {}).then(
        (answer) => {
          if (!live || answer.keys.every((k) => known.includes(k.id))) return;
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
      <ModalPanel onClose={close} title="Pair the Office add-in" description="Enter this code in the Docket pane in Excel, Word or PowerPoint." size="sm">
        <ModalBody>
          <div className="flex items-baseline justify-between gap-3">
            {/* The code's own 24px line, drawn from a sample code: nothing moves when it lands. */}
            <Region inline loading={!code && !error} label="Asking for a code" bones={<CodeLine code="R4T8W2NB" />}>
              {code ? <CodeLine code={code.code} /> : null}
            </Region>
            {code ? (
              <span className="text-xs text-muted-foreground tabular-nums">
                {left > 0 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : "Expired"}
              </span>
            ) : null}
          </div>
          <ErrorLine error={error} />
        </ModalBody>
        <DialogFooter confirmLabel="Done" onConfirm={close} />
      </ModalPanel>
    </Dialog>
  );
}

/** A pairing code on its 24px line. */
function CodeLine({ code }: { code: string }) {
  return <span className="font-mono text-base font-medium leading-6 text-foreground tabular-nums">{code}</span>;
}
