import { useEffect, useState } from "react";
import { takeOfChip, type PlayRow, type PlayTake } from "@shared/contract-work-routines";
import type { ContextChip, MentionAnswer, MentionHit } from "@shared/work";
import { DialogFooter, ErrorLine } from "../../../chrome/ConfirmDialog";
import { Field } from "../../../chrome/DialogField";
import { Modal, ModalBody, useModalClose } from "../../../chrome/Modal";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { ItemButton } from "../../../components/ui/item";
import { Skeleton } from "../../../components/ui/skeleton";
import { Spinner } from "../../../components/ui/spinner";
import { Textarea } from "../../../components/ui/textarea";
import { registry } from "../../../lib/connection";
import { refusalWords } from "../../../lib/settingsHome";
import { startPlay, usePlays } from "./data";
import { alsoLine, pickerKinds, playsFor, startInputs, TAKE_LABEL, takesLeft, today } from "./model";

/** A thing the start hands the play, as it stands chosen. */
const CHOSEN = "truncate rounded-lg bg-muted px-2.5 py-1.5 text-[13px] text-foreground";

type Props = {
  env: string;
  workspaceId: string;
  /** The thing it was started from (Run a play… on a mail, a task, an event or a file); none from the Plays view. */
  chip?: ContextChip;
  /** The play, when he picked it already. */
  play?: PlayRow;
  onClose: () => void;
};

/**
 * Starting a play that needs more than one press (docs/agents/work-plays.md):
 * from a thing, first the plays that take it; then what the play still takes,
 * each its own field. Start makes the thread and opens it.
 */
export function RunDialog(props: Props) {
  const [play, setPlay] = useState<PlayRow | null>(props.play ?? null);
  const [pending, setPending] = useState(false);
  const noun = props.chip ? props.chip.kind : null;
  return (
    <Modal onClose={props.onClose} title={play ? play.name : "Run a play"} description={play ? undefined : props.chip?.label} size="md" busy={pending} data-play-run="">
      {play ? (
        <Inputs {...props} play={play} pending={pending} setPending={setPending} />
      ) : (
        <Pick {...props} noun={noun ?? "thing"} onPick={setPlay} pending={pending} setPending={setPending} />
      )}
    </Modal>
  );
}

function Pick({ env, workspaceId, chip, onClose, onPick, noun, pending, setPending }: Props & { noun: string; onPick: (p: PlayRow) => void; pending: boolean; setPending: (p: boolean) => void }) {
  const close = useModalClose();
  const [load, retry] = usePlays(env, workspaceId);
  const [starting, setStarting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const plays = load.status === "ready" ? playsFor(load.value, chip?.kind ?? "") : [];

  // A play that needs nothing more than this thing starts on the press; one that does asks for the rest.
  const choose = (play: PlayRow) => {
    if (takesLeft(play, chip ? [chip] : []).length) return onPick(play);
    setStarting(play.id);
    setPending(true);
    setError(null);
    startPlay(env, play.id, { chips: chip ? [chip] : [] }).then(
      () => {
        setPending(false);
        close ? close(() => {}) : onClose();
      },
      (err: Error) => {
        setPending(false);
        setStarting(null);
        setError(err.message);
      },
    );
  };

  return (
    <>
      <ModalBody>
        {load.status === "loading" ? (
          <div aria-busy="true" aria-label="Loading plays" className="flex flex-col gap-2 py-1">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-2/5" />
          </div>
        ) : load.status === "error" ? (
          <p className="flex items-baseline gap-2 text-[13px]">
            <span className="min-w-0 text-destructive">{load.error}</span>
            <Button variant="ghost" size="xs" onClick={retry}>
              Retry
            </Button>
          </p>
        ) : plays.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">No play takes a {noun} yet.</p>
        ) : (
          <ul aria-label="Plays" className="-mx-2 flex flex-col gap-px">
            {plays.map((p) => (
              <li key={p.id} className="flex flex-col">
                <ItemButton disabled={pending} onClick={() => choose(p)} className="flex-col items-stretch gap-0.5 px-2 py-1.5">
                  <span className="flex min-w-0 items-baseline gap-2 text-[13px]">
                    <span className="min-w-0 flex-1 truncate font-medium text-foreground">{p.name}</span>
                    {starting === p.id ? (
                      <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                        <Spinner aria-hidden className="size-3" />
                        Starting…
                      </span>
                    ) : null}
                  </span>
                  {takesLeft(p, chip ? [chip] : []).length ? <span className="truncate text-xs text-muted-foreground">{alsoLine(takesLeft(p, chip ? [chip] : []))}</span> : null}
                </ItemButton>
              </li>
            ))}
          </ul>
        )}
        <ErrorLine error={error} />
      </ModalBody>
      <DialogFooter onCancel={onClose} busy={pending} />
    </>
  );
}

function Inputs({ env, workspaceId, chip, play, onClose, pending, setPending }: Props & { play: PlayRow; pending: boolean; setPending: (p: boolean) => void }) {
  const close = useModalClose();
  const given = chip ? [chip] : [];
  const left = takesLeft(play, given);
  const [picked, setPicked] = useState<Partial<Record<PlayTake, ContextChip>>>({});
  const [date, setDate] = useState(() => today());
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const start = () => {
    const chips = [...given, ...left.flatMap((t) => (picked[t] ? [picked[t]!] : []))];
    const ready = startInputs(play, { chips, date, text });
    if ("problem" in ready) return setError(ready.problem);
    setError(null);
    setPending(true);
    startPlay(env, play.id, ready.inputs).then(
      () => {
        setPending(false);
        close ? close(() => {}) : onClose();
      },
      (err: Error) => {
        setPending(false);
        setError(err.message);
      },
    );
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        start();
      }}
    >
      <ModalBody>
        {chip ? (
          <Field label={TAKE_LABEL[takeOfChip(chip.kind) ?? "file"]}>
            <p className={CHOSEN}>{chip.label}</p>
          </Field>
        ) : null}
        {left.map((take, i) =>
          take === "date" ? (
            <Field key={take} label="Date">
              <Input type="date" autoFocus={i === 0} value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
          ) : take === "text" ? (
            <Field key={take} label="Text">
              <Textarea autoFocus={i === 0} rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste or type what it works from" />
            </Field>
          ) : (
            <Picker key={take} env={env} workspaceId={workspaceId} take={take} first={i === 0} chip={picked[take]} onChip={(c) => setPicked((cur) => ({ ...cur, [take]: c }))} />
          ),
        )}
        <ErrorLine error={error} />
      </ModalBody>
      <DialogFooter onCancel={onClose} confirmLabel="Start" busyLabel="Starting…" pending={pending} />
    </form>
  );
}

/** One thing the play takes, found as the composer's @ finds it, in this workspace's reach. */
function Picker({ env, workspaceId, take, first, chip, onChip }: { env: string; workspaceId: string; take: PlayTake; first: boolean; chip: ContextChip | undefined; onChip: (c: ContextChip | undefined) => void }) {
  const [query, setQuery] = useState("");
  const [answer, setAnswer] = useState<{ hits: MentionHit[] } | { error: string } | null>(null);
  useEffect(() => {
    if (chip) return;
    let live = true;
    // The first ask goes at once, then a beat after the last key, as the composer's @ does.
    const timer = setTimeout(
      () =>
        registry
          .linkOf(env)
          .request<MentionAnswer>("work.canvas.mentions", { sessionId: `play-${workspaceId}`, draft: { workspaceId, work: true }, text: query, kinds: pickerKinds(take) })
          .then(
            (a) => live && setAnswer(a.failed?.length && !a.hits?.length ? { error: "Couldn't reach LifeOS" } : { hits: a.hits ?? [] }),
            (err: unknown) => live && setAnswer({ error: refusalWords(err) || "The host did not answer" }),
          ),
      query ? 120 : 0,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [env, workspaceId, take, query, chip]);

  const label = TAKE_LABEL[take];
  if (chip)
    return (
      <Field
        label={label}
        aside={
          <Button type="button" variant="link" size="xs" className="h-auto px-0 text-xs" onClick={() => onChip(undefined)}>
            Change
          </Button>
        }
      >
        <p className={CHOSEN}>{chip.label}</p>
      </Field>
    );
  return (
    <Field label={label}>
      <div className="flex flex-col gap-1">
        <Input autoFocus={first} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Search ${label.toLowerCase()}`} autoComplete="off" />
        {answer === null ? (
          <Skeleton className="mx-2 my-1.5 h-4 w-1/2" />
        ) : "error" in answer ? (
          <p className="px-2 py-1.5 text-xs text-destructive">{answer.error}</p>
        ) : answer.hits.length === 0 ? (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">No {label.toLowerCase()} matches</p>
        ) : (
          <ul aria-label={`${label} found`} className="flex flex-col gap-px">
            {answer.hits.map((hit) => (
              <li key={JSON.stringify(hit.chip.ref)} className="flex flex-col">
                <ItemButton type="button" onClick={() => onChip(hit.chip)} className="h-8 items-center gap-3 px-2 text-[13px]">
                  <span className="min-w-0 flex-1 truncate text-foreground">{hit.chip.label}</span>
                  {hit.detail ? <span className="max-w-[40%] shrink-0 truncate text-xs text-muted-foreground">{hit.detail}</span> : null}
                </ItemButton>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Field>
  );
}
