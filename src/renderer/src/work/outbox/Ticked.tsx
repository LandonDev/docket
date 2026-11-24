import { useEffect, useState, type RefObject } from "react";
import { Button } from "../../components/ui/button";
import { Tip } from "../../components/tip";
import { workErrorWords } from "../../lib/workErrorWords";
import { ownZone } from "work-kit/mail/lib/zones";
import { DiscardButton, PickTime, SendSplit, useKeyVerbs, type DetailCommands } from "./HeldDetail";
import { DetailColumn, VerbBar } from "./parts";
import { decideMany, fetchItem, type DecideDo, type HostItem } from "./store";
import { SummaryList } from "./SummaryList";
import { doneWords, itemKey, openOnly, resultsHead, summaryHead, type RowResult } from "./waiting";

/**
 * The ticked rows as one press (docs/DESIGN.md "The Outbox", "Ticks and the
 * summary"): the summary list, then Clear, Discard N, and Send N joined to
 * Send later. One `work.outbox.decide` per host; each row shows its result
 * as its host answers, and the head says the sum ("Sent 5, 1 not sent").
 * What only its own page sends stays out of Send N and says "Open to send".
 */

/** A press on many, once made: what it took, what it did, and each item's result as it lands. */
export type Batch = { items: HostItem[]; did: "send" | "discard" | "later"; results: ReadonlyMap<string, RowResult> };

/** LifeOS mail among these that quotes the mail it answers, read whole: those go only from their own page. */
function useQuoted(items: readonly HostItem[]): ReadonlySet<string> {
  const mails = items.filter((i) => i.kind === "mail.send");
  const key = mails.map((i) => `${itemKey(i)}@${i.updatedAt}`).join(",");
  const [quoted, setQuoted] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    let live = true;
    void Promise.all(mails.map((i) => fetchItem(i.environmentId, i.ref).then((whole) => ((whole.payload as { quote?: string } | null)?.quote ? itemKey(i) : null), () => null))).then(
      (keys) => live && setQuoted(new Set(keys.filter((k): k is string => k !== null))),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read again when the mails or their words change
  }, [key]);
  return quoted;
}

/** One press on many: the results land on `batch` as each host answers. */
export async function pressMany(items: readonly HostItem[], choice: DecideDo, setBatch: (update: (b: Batch | null) => Batch | null) => void): Promise<void> {
  const did = choice.do;
  setBatch(() => ({ items: [...items], did, results: new Map(items.map((i) => [itemKey(i), { state: "working" } as RowResult])) }));
  const byKey = new Map(items.map((i) => [itemKey(i), i]));
  await decideMany(items, choice, {
    via: "outbox",
    onHost: (answers) =>
      setBatch((b) => {
        if (!b) return b;
        const results = new Map(b.results);
        for (const [key, answer] of answers) {
          const item = byKey.get(key)!;
          results.set(
            key,
            answer.ok
              ? { state: "done", words: doneWords({ ...item, ...answer.item }, did) }
              : { state: "failed", words: workErrorWords(answer.error ?? "") || (did === "discard" ? "It was not discarded" : "It did not go") },
          );
        }
        return { ...b, results };
      }),
  });
}

export function TickedDetail({
  items,
  batch,
  host,
  onToggle,
  onClear,
  onPress,
  onSendAgain,
  commands,
}: {
  /** The ticked rows (none once a press was made: `batch` shows instead). */
  items: HostItem[];
  batch: Batch | null;
  host: (item: HostItem) => string;
  onToggle: (item: HostItem, on: boolean) => void;
  onClear: () => void;
  onPress: (items: HostItem[], choice: DecideDo) => void;
  /** The failed rows of a press, sent again. */
  onSendAgain: (keys: string[]) => void;
  commands?: RefObject<DetailCommands | null>;
}) {
  const quoted = useQuoted(items);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const only = (item: HostItem) => openOnly(item, quoted.has(itemKey(item)));
  const goes = items.filter((i) => !only(i));
  const later = goes.length > 0 && goes.every((i) => i.later === true);
  const busy = !!batch && [...batch.results.values()].some((r) => r.state === "working");
  const failed = batch ? [...batch.results].filter(([, r]) => r.state === "failed").map(([k]) => k) : [];

  const verbs: DetailCommands = {
      primary: () => !batch && goes.length > 0 && onPress(goes, { do: "send" }),
      edit: () => {},
      discard: () => {
        if (!batch) setDiscardOpen(true);
      },
      later: () => {
        if (!batch && later) setMenuOpen(true);
      },
      editing: () => false,
      cancelEdit: () => {},
  };
  useKeyVerbs(commands, verbs);

  if (batch)
    return (
      <>
        <DetailColumn>
          <SummaryList head={resultsHead([...batch.results.values()], batch.did) || "Working"} rows={batch.items.map((item) => ({ item, on: true, result: batch.results.get(itemKey(item)) }))} host={host} />
        </DetailColumn>
        <VerbBar>
          <Tip label="Clear" shortcut="Esc">
            <Button variant="ghost" size="sm" disabled={busy} onClick={onClear}>
              Clear
            </Button>
          </Tip>
          <span className="flex-1" />
          {!busy && failed.length && batch.did === "send" ? (
            <Button variant="secondary" size="sm" onClick={() => onSendAgain(failed)}>
              Send {failed.length} again
            </Button>
          ) : null}
        </VerbBar>
      </>
    );

  return (
    <>
      <DetailColumn>
        <SummaryList
          head={summaryHead(goes, goes.length ? 0 : items.length)}
          rows={items.map((item) => ({ item, on: true, side: only(item) ? "Open to send" : null }))}
          onToggle={onToggle}
          host={host}
        />
      </DetailColumn>
      <VerbBar>
        <Tip label="Clear" shortcut="Esc">
          <Button variant="ghost" size="sm" onClick={onClear}>
            Clear
          </Button>
        </Tip>
        <span className="flex-1" />
        <DiscardButton
          label={`Discard ${items.length}`}
          busy={false}
          disabled={false}
          open={discardOpen}
          onOpenChange={setDiscardOpen}
          onDiscard={(reason) => onPress(items, { do: "discard", reason })}
        />
        {goes.length ? (
          <SendSplit
            label={`Send ${goes.length}`}
            verb="Send"
            busy={false}
            disabled={false}
            later={later}
            grant={null}
            open={menuOpen}
            onOpenChange={setMenuOpen}
            onPress={() => onPress(goes, { do: "send" })}
            onLater={(at) => onPress(goes, { do: "later", at, zone: ownZone() })}
            onPickTime={() => setPicking(true)}
          />
        ) : null}
      </VerbBar>
      {picking ? (
        <PickTime
          onClose={() => setPicking(false)}
          onPick={(at) => {
            setPicking(false);
            onPress(goes, { do: "later", at, zone: ownZone() });
          }}
        />
      ) : null}
    </>
  );
}
