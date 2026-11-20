import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import type { FormBody, FormQuestion, FormResponses, FormView } from "@shared/contract-work-forms";
import { Check, ChevronDown, CircleDot, Copy, FileText, MoreHorizontal, Plus, TextCursor, Trash2, X, CaseSensitive } from "../../chrome/icons";
import { BusyLabel, Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../components/ui/dropdown-menu";
import { Input, INPUT_FIELD_CLASS } from "../../components/ui/input";
import { Skeleton } from "../../components/ui/skeleton";
import { Switch } from "../../components/ui/switch";
import { Textarea } from "../../components/ui/textarea";
import { Table as DataTable, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { Tabs, TabsIndicator, TabsList, TabsTrigger, TABS_PILL_TRIGGER } from "../../components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip";
import { Tip, TruncateTip } from "../../components/tip";
import { loadToast } from "../../components/ui/toaster";
import { cn } from "../../lib/cn";
import { dayTime } from "../../lib/duration";
import { EmptyState } from "../../surfaces/SurfaceSkeleton";
import { sayError } from "../canvas/frame";
import type { CanvasBodyProps, CanvasShell, ReviewAdapter } from "../canvas/kind";
import { Table } from "../icons";
import { AddQuestion } from "./AddQuestion";
import { linkFormHost, type FormHost } from "./host";
import { answerBars, chartQuestion, liveView, optionDiff, plural, resolvePick, shownQuestions, submittedTime, TYPE_WORDS, type Pick, type Shown } from "./model";

/**
 * The form kind (docs/agents/work-forms.md; the approved page is
 * .temp-code/prototypes/work-workspaces-2/form.html, "Questions, then
 * Responses"): two halves switched in the bar. Questions is the form as a
 * filler sees it, each question edited where it stands; Responses is one
 * summary line, the bars of the form's choice question and a flat table.
 * Publishing is held; the bar's Publish is his press. Closing and reopening
 * are not.
 */

export type Half = "questions" | "responses";
export interface FormState {
  half: Half;
}

/** One item's view and what this window keeps of it, shared by the body and the bar. */
interface Slot {
  view: FormView | null;
  error: string | null;
  half: Half;
  publishing: boolean;
  /** His edits, standing over the host's view until the save that carries them answers; kept when a save fails. */
  edits: FormBody | null;
  /** Why the last save failed, while his edits wait unsaved. */
  saveError: string | null;
  /** Why Responses could not be read, while nothing of them is shown; said on the state line. */
  responsesError: string | null;
  /** Bumped by Retry to read the responses again. */
  responsesAttempt: number;
}
class FormStore {
  private slot: Slot;
  private readonly listeners = new Set<() => void>();
  constructor(half: Half) {
    this.slot = { view: null, error: null, half, publishing: false, edits: null, saveError: null, responsesError: null, responsesAttempt: 0 };
  }
  get = (): Slot => this.slot;
  set = (patch: Partial<Slot>): void => {
    // Every view the canvas reads holds only the changes that stand (`liveView`): a change kept against a question since
    // gone is never counted, stepped to or decided, whatever host version sent it.
    this.slot = { ...this.slot, ...patch, ...(patch.view ? { view: liveView(patch.view) } : {}) };
    for (const l of this.listeners) l();
  };
  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
}
const stores = new Map<string, FormStore>();
const storeOf = (itemId: string, half: Half = "questions"): FormStore => {
  let s = stores.get(itemId);
  if (!s) stores.set(itemId, (s = new FormStore(half)));
  return s;
};
const hosts = new Map<string, FormHost>();
function hostFor(props: CanvasBodyProps<FormState> & { host?: FormHost }): FormHost {
  if (props.host) return props.host;
  const key = `${props.env}\n${props.item.id}`;
  let host = hosts.get(key);
  if (!host) hosts.set(key, (host = linkFormHost(props.env, props.item)));
  return host;
}
const useSlot = (store: FormStore): Slot => useSyncExternalStore(store.subscribe, store.get);

type Props = CanvasBodyProps<FormState> & { host?: FormHost };

export function Body(props: Props) {
  const { item, shell, state, setState } = props;
  const host = hostFor(props);
  const store = storeOf(item.id, state?.half);
  const slot = useSlot(store);
  const { view, error, half } = slot;

  // A failed open is said once, on the state line with Retry; Retry opens it again.
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    host.open().then(
      (v) => live && store.set({ view: v, error: null }),
      (e: unknown) => live && store.set({ error: e instanceof Error ? e.message : "The form did not load." }),
    );
    const off = host.watch((v) => store.set({ view: v }));
    return () => {
      live = false;
      off();
    };
  }, [host, store, attempt]);
  useEffect(() => {
    if (state?.half !== half) setState({ half });
  }, [half, state?.half, setState]);

  // One selection for the stepper and the body: the picked change by its id, re-seated when a decision takes it away.
  const [pick, setPick] = useState<Pick>({ id: null, at: 0 });
  const suggestions = view?.suggestions;
  const current = resolvePick(suggestions ?? [], pick);
  const step = useCallback((n: number) => setPick({ id: suggestions?.[n]?.id ?? null, at: n }), [suggestions]);
  useFeeds(shell, host, store, view, half, current, step, slot.edits !== null, slot.edits !== null && slot.saveError !== null);
  const saveError = slot.saveError;
  const responsesError = half === "responses" ? slot.responsesError : null;
  useEffect(() => {
    const retryOpen = (): void => {
      store.set({ error: null });
      setAttempt((n) => n + 1);
    };
    if (error) shell.statusLine({ tone: "failed", word: "Couldn't open this form", detail: error, action: { label: "Retry", run: retryOpen } });
    else if (saveError) shell.statusLine({ tone: "failed", word: "Not saved", detail: saveError, action: { label: "Retry", run: () => saverOf(store, host).retry() } });
    else if (responsesError)
      shell.statusLine({
        tone: "failed",
        word: "Couldn't read the responses",
        detail: responsesError,
        action: { label: "Retry", run: () => store.set({ responsesError: null, responsesAttempt: store.get().responsesAttempt + 1 }) },
      });
    else shell.statusLine(null);
    return () => shell.statusLine(null);
  }, [shell, host, store, error, saveError, responsesError]);

  if (error) return null;
  if (!view) return <FormSkeleton />;
  return (
    <div data-form className="flex min-h-0 min-w-0 flex-1 flex-col">
      {view.state === "closed" && view.closedAt ? <ClosedLine at={view.closedAt} reopen={() => run(host.close(true), store, "Couldn't reopen the form")} /> : null}
      {half === "questions" ? (
        <Questions key={view.itemId} view={view} host={host} store={store} current={current} onStep={step} />
      ) : (
        <Responses view={view} host={host} store={store} item={props.item} shell={shell} />
      )}
    </div>
  );
}

const run = (work: Promise<FormView>, store: FormStore, fallback: string): Promise<void> =>
  work.then(
    (v) => store.set({ view: v }),
    (e: unknown) => sayError(e, fallback),
  );

/** An accept, and what it cleared with a removed question, said once: the changes that went with it, as the host names them. */
const accept = (work: ReturnType<FormHost["review"]>, store: FormStore): Promise<void> =>
  work.then(
    (v) => {
      store.set({ view: v });
      const cleared = v.cleared ?? [];
      if (cleared.length) void loadToast().then((toast) => toast(`Cleared ${plural(cleared.length, "change")} to the removed question`, { description: cleared.join(", ") }));
    },
    (e: unknown) => sayError(e, "Couldn't accept the change"),
  );

/** What the body tells the pane: the mode, the stepper over waiting changes, the line after a direct write, More's own rows. */
function useFeeds(
  shell: CanvasShell,
  host: FormHost,
  store: FormStore,
  view: FormView | null,
  half: Half,
  current: number,
  setCurrent: (n: number) => void,
  /** his edits stand unsaved (waiting, saving or refused), so the questions draw no suggested change (`Questions`) */
  editing: boolean,
  /** the save that carries them failed: they stand until Retry lands them */
  refused: boolean,
): void {
  const mode = view?.mode;
  const published = view ? view.state !== "draft" : false;
  useEffect(() => {
    if (!mode) return shell.mode(null);
    // Once the page is public every change waits for him, whatever the mode.
    if (published) shell.mode({ value: "suggests", note: "The form is published, so every change waits for you" });
    else shell.mode({ value: mode, set: (next) => void run(host.mode(next), store, "Couldn't change what the agent does") });
    return () => shell.mode(null);
  }, [shell, host, store, mode, published]);

  const suggestions = view?.suggestions;
  // A change is decided only where it is drawn: on Questions, and only while no edit of his stands unsaved over them (the
  // questions then draw his words, not the diffs, until the save that carries them lands). While that save is on its way
  // the stepper stays drawn with its verbs off (`held`), so the bar does not flicker at each pause in his typing; once it
  // has failed, the state line says so with Retry and the stepper goes until the save lands.
  const shown = half === "questions" && !refused;
  useEffect(() => {
    // A change is a question: while Responses shows none is on screen, so the frame draws no stepper (no "0/N", no verbs
    // waiting on nothing) and the bar's Questions control is the way back to them (`Bar`).
    if (!suggestions?.length || !shown) return shell.review(null);
    // A press that reaches the adapter while his edits hide the diffs settles nothing he cannot see.
    const hidden = (): boolean => store.get().edits !== null;
    const ids = (w: number | { group: string } | "all"): { ids: string[] } | "all" => (typeof w === "number" ? { ids: [suggestions[w]?.id].filter(Boolean) } : "all");
    const review: ReviewAdapter = {
      groups: [{ id: "form", label: "Questions", by: suggestions[0].by, count: suggestions.length }],
      index: current,
      count: suggestions.length,
      held: editing,
      step: setCurrent,
      accept: (w) => (hidden() ? Promise.resolve() : accept(host.review(ids(w), "accept"), store)),
      reject: (w) => (hidden() ? Promise.resolve() : run(host.review(ids(w), "reject"), store, "Couldn't reject the change")),
    };
    shell.review(review);
    return () => shell.review(null);
  }, [shell, host, store, suggestions, shown, editing, current, setCurrent]);

  const written = view?.written;
  const waiting = suggestions?.length ?? 0;
  useEffect(() => {
    if (!written || waiting) return shell.written(null);
    shell.written({ text: `${written.text}, ${dayTime(written.at)}` });
    return () => shell.written(null);
  }, [shell, written, waiting]);

  const sheet = view?.sheet;
  const title = view?.body.title;
  useEffect(() => {
    if (!sheet || !title) return shell.more?.(null);
    shell.more?.([{ id: "sheet", label: "Open responses as a sheet", icon: Table, run: () => host.openSheet(sheet, `${title}, responses`) }]);
    return () => shell.more?.(null);
  }, [shell, host, sheet, title]);
}

// ── the bar ──────────────────────────────────────────────────────────

export function Bar(props: Props) {
  const host = hostFor(props);
  const store = storeOf(props.item.id, props.state?.half);
  const { view, error, half, publishing, edits } = useSlot(store);
  // While the form loads the bar holds one bone where the switch will be, so the body never moves under it.
  if (!view) return error ? null : <Skeleton data-form-bar-bone className="h-3 w-30" />;
  const publish = (): void => {
    store.set({ publishing: true });
    void run(host.publish(), store, "Couldn't publish the form").finally(() => store.set({ publishing: false }));
  };
  // While changes wait the switch gives way whole in a narrow bar: on Questions to the stepper, on Responses to one compact
  // Questions control that leads back to them. Never both: the control shows only where the switch has gone.
  const waiting = view.suggestions.length;
  const away = waiting > 0 && half === "responses";
  return (
    <>
      <Tabs
        value={half}
        onValueChange={(next) => store.set({ half: next as Half })}
        data-narrow-hide={waiting > 0 || undefined}
        className={`mx-1 shrink-0 gap-0 ${waiting ? "@max-[560px]/bar:hidden" : ""}`}
      >
        <TabsList aria-label="Half" className="relative p-0.5 group-data-[orientation=horizontal]/tabs:h-6">
          <TabsIndicator />
          <TabsTrigger value="questions" className={`${TABS_PILL_TRIGGER} px-2 text-xs`}>
            Questions
            {away ? <Waiting n={waiting} /> : null}
          </TabsTrigger>
          <TabsTrigger value="responses" className={`${TABS_PILL_TRIGGER} px-2 text-xs`}>
            Responses
          </TabsTrigger>
        </TabsList>
      </Tabs>
      {away ? (
        <Button variant="ghost" size="xs" data-form-to-questions className="hidden shrink-0 @max-[560px]/bar:inline-flex" onClick={() => store.set({ half: "questions" })}>
          Questions
          <Waiting n={waiting} />
        </Button>
      ) : null}
      {view.suggestions.length ? null : view.state === "draft" ? (
        // The host holds its last saved copy: Publish waits until his latest edit has saved, and stays off through a failed
        // save until Retry lands it (the state line says why). It spins only for its own press.
        <Button size="xs" className="ms-auto" disabled={publishing || edits !== null} onClick={publish}>
          <BusyLabel busy={publishing} label="Publish" />
        </Button>
      ) : view.state === "open" && view.link ? (
        <LiveLink link={view.link} close={() => run(host.close(false), store, "Couldn't close the form")} />
      ) : null}
    </>
  );
}

/** How many changes wait on the Questions half, said beside its name while Responses shows and the stepper is gone. */
function Waiting({ n }: { n: number }) {
  return <span className="text-muted-foreground tabular-nums">{n}</span>;
}

function LiveLink({ link, close }: { link: string; close(): Promise<void> }) {
  const [copied, setCopied] = useState(false);
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = (): void =>
    void navigator.clipboard.writeText(link).then(
      () => setCopied(true),
      () => sayError(null, "Couldn't copy the link"),
    );
  const shown = link.replace(/^https?:\/\//, "");
  // Under 600px of bar the address and its glyph give way to a worded Copy link (form.html's narrow bar), so nothing is cut.
  return (
    <span data-form-link className="ms-auto flex min-w-0 items-center gap-1">
      <TruncateTip text={shown}>
        <a href={link} target="_blank" rel="noreferrer" className="min-w-0 truncate text-xs text-link underline-offset-3 hover:underline @max-[600px]/bar:hidden">
          {shown}
        </a>
      </TruncateTip>
      <Tip label={copied ? "Copied" : "Copy link"}>
        <Button variant="ghost" size="icon-xs" aria-label={copied ? "Copied" : "Copy link"} onClick={copy} className="text-muted-foreground @max-[600px]/bar:hidden">
          {copied ? <Check /> : <Copy />}
        </Button>
      </Tip>
      <Button data-form-copy-word variant="ghost" size="xs" onClick={copy} className="hidden @max-[600px]/bar:inline-flex">
        {copied ? <Check /> : <Copy />}
        {copied ? "Copied" : "Copy link"}
      </Button>
      <Button
        variant="ghost"
        size="xs"
        disabled={closing}
        onClick={() => {
          setClosing(true);
          void close().finally(() => setClosing(false));
        }}
      >
        <BusyLabel busy={closing} label="Close form" />
      </Button>
    </span>
  );
}

function ClosedLine({ at, reopen }: { at: number; reopen(): Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <div data-form-closed className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-3 text-xs text-muted-foreground">
      <span className="min-w-0 flex-1 truncate">Closed {dayTime(at)}</span>
      <Button
        variant="ghost"
        size="xs"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void reopen().finally(() => setBusy(false));
        }}
      >
        <BusyLabel busy={busy} label="Reopen" />
      </Button>
    </div>
  );
}

// ── questions ────────────────────────────────────────────────────────

const SAVE_AFTER = 500;

/**
 * His edits go to the host half a second after the last one, one save at a
 * time, each at the rev the host last answered (read when it goes, never
 * when it was typed). The edits stand in the store until a save of them
 * answers; a save that fails keeps them, and the state line says so with
 * Retry. A pending edit is sent at once when the half closes (`flush`).
 */
interface Saver {
  later(next: FormBody): void;
  flush(): void;
  retry(): Promise<void>;
  /**
   * Saves `next` at once, after any save in flight, and settles with it: a refusal rejects and puts back the edits that
   * stood before, so what was asked for never shows as made (Add question).
   */
  now(next: FormBody): Promise<void>;
}
const savers = new WeakMap<FormStore, Saver>();
function saverOf(store: FormStore, host: FormHost): Saver {
  const had = savers.get(store);
  if (had) return had;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let waiting: FormBody | null = null;
  let busy = false;
  let queued: FormBody | null = null;
  let current: Promise<void> = Promise.resolve();
  const send = (next: FormBody): Promise<void> => {
    if (busy) {
      queued = next;
      return Promise.resolve();
    }
    const rev = store.get().view?.rev;
    if (rev === undefined) return Promise.resolve();
    busy = true;
    return (current = host
      .save(rev, next)
      .then(
        (v) => store.set({ view: v, saveError: null, edits: store.get().edits === next ? null : store.get().edits }),
        (e: unknown) => store.set({ saveError: e instanceof Error && e.message ? e.message : "The host did not answer" }),
      )
      .finally(() => {
        busy = false;
        const again = queued;
        queued = null;
        if (again) void send(again);
      }));
  };
  const saver: Saver = {
    later(next) {
      store.set({ edits: next });
      waiting = next;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        waiting = null;
        void send(next);
      }, SAVE_AFTER);
    },
    flush() {
      if (!timer || !waiting) return;
      clearTimeout(timer);
      timer = null;
      const next = waiting;
      waiting = null;
      void send(next);
    },
    retry() {
      const edits = store.get().edits;
      return edits ? send(edits) : Promise.resolve();
    },
    async now(next) {
      if (timer) clearTimeout(timer);
      timer = null;
      waiting = null;
      // `next` carries every edit that stood, a queued one included.
      queued = null;
      const before = store.get().edits;
      store.set({ edits: next });
      while (busy) await current;
      await send(next);
      const refused = store.get().saveError;
      if (refused === null) return;
      // Nothing was made: the edits that stood before are back, and the state line keeps its Retry only for them.
      store.set({ edits: before, saveError: before ? refused : null });
      throw new Error(refused);
    },
  };
  savers.set(store, saver);
  return saver;
}

function Questions({ view, host, store, current, onStep }: { view: FormView; host: FormHost; store: FormStore; current: number; onStep(n: number): void }) {
  // His edits stand over the host's view until the save that carries them answers.
  const { edits } = useSlot(store);
  const [focus, setFocus] = useState<string | null>(null);
  const saver = saverOf(store, host);
  useEffect(() => () => saver.flush(), [saver]);
  const body = edits ?? view.body;
  const editable = view.state !== "closed";
  const edit = (next: FormBody): void => saver.later(next);

  const shown = useMemo(() => shownQuestions(body, edits ? [] : view.suggestions, current), [body, edits, view.suggestions, current]);
  const list = useRef<HTMLDivElement>(null);
  // The selected change comes into view whenever it is another change, a re-seat after a decision included.
  const selected = view.suggestions[current]?.id;
  useEffect(() => {
    if (selected) list.current?.querySelector(`[data-change="${current}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [selected, current]);

  const setQuestion = (id: string, q: FormQuestion | null): void =>
    edit({ ...body, questions: q ? body.questions.map((x) => (x.id === id ? q : x)) : body.questions.filter((x) => x.id !== id) });
  // A new question is written in a dialog and made on its Add, never as a placeholder on the form.
  const [adding, setAdding] = useState(false);
  const addQuestion = async (q: FormQuestion): Promise<void> => {
    const now = store.get().edits ?? store.get().view?.body ?? body;
    await saver.now({ ...now, questions: [...now.questions, q] });
    requestAnimationFrame(() => list.current?.querySelector(`[data-q="${q.id}"]`)?.scrollIntoView?.({ block: "nearest" }));
  };
  const sections = shown.filter((s) => s.q.type === "section");

  return (
    <div className="@container flex min-h-0 flex-1">
      {sections.length >= 3 ? <Jump sections={sections} /> : null}
      <div ref={list} data-form-scroll className="min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain scroll-smooth motion-reduce:scroll-auto">
        <div className={`mx-auto max-w-[560px] px-6 pt-6 pb-12 ${view.state === "closed" ? "[&_[data-field]]:opacity-60" : ""}`}>
          <TextField value={body.title} label="Title" editable={editable} onChange={(title) => edit({ ...body, title })} className="px-3 text-lg leading-[26px] font-semibold tracking-[-0.01em]" />
          <TextField
            value={body.description}
            label="Description"
            placeholder={editable ? "Add a line about the form" : undefined}
            editable={editable}
            multiline
            onChange={(description) => edit({ ...body, description })}
            className="mt-1 px-3 text-sm leading-[22px] text-muted-foreground"
          />
          <div className="mt-4 flex flex-col gap-1">
            {shown.map((s) => (
              <QuestionBlock
                key={`${s.q.id}${s.mark ?? ""}`}
                shown={s}
                focused={focus === s.q.id && !s.mark}
                current={s.change !== undefined && s.change === current}
                editable={editable && !s.mark}
                opens={editable || s.change !== undefined}
                onFocus={() => {
                  if (s.change !== undefined) onStep(s.change);
                  else setFocus(s.q.id);
                }}
                onChange={(q) => setQuestion(s.q.id, q)}
              />
            ))}
          </div>
          {editable ? (
            <Button variant="ghost" size="sm" className="mt-2 ms-1 text-muted-foreground" onClick={() => setAdding(true)}>
              <Plus />
              Add question
            </Button>
          ) : null}
          {adding ? <AddQuestion onAdd={addQuestion} onClose={() => setAdding(false)} /> : null}
        </div>
      </div>
    </div>
  );
}

/** A long form's sections as a jump list, as PlanView's outline draws one; gone under 640px of canvas. */
function Jump({ sections }: { sections: Shown[] }) {
  return (
    <nav aria-label="Sections" className="hidden w-44 shrink-0 flex-col gap-0.5 py-6 ps-4 pe-2 @[640px]:flex">
      {sections.map((s) => (
        <Button
          key={s.q.id}
          variant="ghost"
          size="sm"
          onClick={() => document.getElementById(`fq-${s.q.id}`)?.scrollIntoView({ block: "start" })}
          className="justify-start font-normal text-muted-foreground hover:text-foreground"
        >
          <span className="truncate">{s.q.label}</span>
        </Button>
      ))}
    </nav>
  );
}

/** Words he edits where they stand: plain text until clicked. */
function TextField({
  value,
  label,
  editable,
  onChange,
  className,
  multiline,
  placeholder,
}: {
  value: string;
  label: string;
  editable: boolean;
  onChange(v: string): void;
  className: string;
  multiline?: boolean;
  placeholder?: string;
}) {
  if (!editable) return value ? <div className={`${className} whitespace-pre-line`}>{value}</div> : null;
  // The design system's fields, borderless at rest so the words stand where they read; the ring shows where the caret is.
  const shared = cn(IN_PLACE, "-my-px h-auto resize-none py-0", className);
  return multiline ? (
    <Textarea aria-label={label} rows={1} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} className={cn(shared, "min-h-0")} />
  ) : (
    <Input aria-label={label} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} className={shared} />
  );
}

/** A field edited where its words stand: the system's Input or Textarea with no border at rest, its focus ring on focus. */
const IN_PLACE = "rounded-md border-transparent";
/** A 20px line's field, its box 4px out each side of the line (and 10px out at the start) so the words do not move when it opens. */
const IN_LINE = `${IN_PLACE} -mx-2.5 -my-1 h-7 w-[calc(100%+20px)] px-2.5 py-0`;

const TYPE_ICONS = { short: TextCursor, long: FileText, choice: CircleDot, dropdown: ChevronDown, section: CaseSensitive } as const;

function QuestionBlock({
  shown,
  focused,
  current,
  editable,
  opens,
  onFocus,
  onChange,
}: {
  shown: Shown;
  focused: boolean;
  current: boolean;
  editable: boolean;
  /** Whether a press does anything: opens the question to edit, or steps to its change. A closed form's questions only read. */
  opens: boolean;
  onFocus(): void;
  onChange(q: FormQuestion | null): void;
}) {
  const { q, mark, was } = shown;
  const editing = focused && editable;
  const tint = mark === "add" ? "bg-(--add-bg)" : mark === "del" ? "bg-(--del-bg)" : editing ? "bg-muted" : opens ? "hover:bg-foreground/4" : "";
  // Reached by the keyboard too: Tab lands on a question, Enter or Space opens it. Keys inside its own fields are theirs.
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault();
    onFocus();
  };
  const press = opens && !editing ? { role: "button", tabIndex: 0, onClick: onFocus, onKeyDown } : {};
  const outline = current ? "outline-1 outline-foreground/40 outline-solid" : "";
  const label =
    mark === "change" && was && was.label !== q.label ? (
      <>
        <s className="bg-(--del-bg) text-muted-foreground">{was.label}</s> <span className="bg-(--add-bg)">{q.label}</span>
      </>
    ) : mark === "del" ? (
      <s className="text-muted-foreground">{q.label}</s>
    ) : (
      q.label
    );
  if (q.type === "section")
    return (
      <div id={`fq-${q.id}`} data-q={q.id} data-change={shown.change} {...press} className={`focus-ring mt-5 rounded-xl px-3 py-1 transition-[background-color] duration-(--dur-hover) ${tint} ${outline}`}>
        {editing ? (
          <SectionEdit q={q} onChange={onChange} />
        ) : (
          <h2 className="text-base leading-6 font-semibold tracking-[-0.01em]">{label}</h2>
        )}
      </div>
    );
  return (
    <div
      id={`fq-${q.id}`}
      data-q={q.id}
      data-change={shown.change}
      data-mark={mark}
      aria-current={focused || current ? "true" : undefined}
      {...press}
      className={`focus-ring rounded-xl p-3 transition-[background-color] duration-(--dur-hover) ${tint} ${outline}`}
    >
      {editing ? (
        <Input aria-label="Question" autoFocus value={q.label} onChange={(e) => onChange({ ...q, label: e.target.value })} className={`${IN_LINE} block text-sm leading-5 font-medium`} />
      ) : (
        <div className="text-sm leading-5 font-medium">
          {label}
          <Required q={q} was={mark === "change" ? was : undefined} gone={mark === "del"} />
        </div>
      )}
      <Field q={q} was={mark === "change" ? was : undefined} proposed={mark === "add" || mark === "change"} editing={editing} onChange={onChange} />
      {editing ? <EditRow q={q} onChange={onChange} /> : null}
    </div>
  );
}

function SectionEdit({ q, onChange }: { q: FormQuestion; onChange(q: FormQuestion | null): void }) {
  return (
    <div className="flex items-center gap-2">
      <Input
        aria-label="Section"
        autoFocus
        value={q.label}
        onChange={(e) => onChange({ ...q, label: e.target.value })}
        className={`${IN_PLACE} -ms-2.5 h-auto min-w-0 flex-1 px-2.5 py-0 text-base leading-6 font-semibold tracking-[-0.01em]`}
      />
      <Tip label="Delete section">
        <Button variant="ghost" size="icon-xs" aria-label="Delete section" className="text-muted-foreground" onClick={() => onChange(null)}>
          <Trash2 />
        </Button>
      </Tip>
    </div>
  );
}

/**
 * Whether an answer is needed: the filler's asterisk at rest; a change that turns it on or off says so in words, tinted as
 * the label's own change is, since a lone struck asterisk is too small to read as a decision.
 */
function Required({ q, was, gone }: { q: FormQuestion; was?: FormQuestion; gone: boolean }) {
  if (was && was.required !== q.required)
    return q.required ? (
      <span data-required="add" className="ms-1.5 bg-(--add-bg) px-0.5 text-xs font-normal text-muted-foreground">
        Required
      </span>
    ) : (
      <s data-required="del" className="ms-1.5 bg-(--del-bg) px-0.5 text-xs font-normal text-(--soft-foreground)">
        Required
      </s>
    );
  return q.required && !gone ? <span className="text-muted-foreground"> *</span> : null;
}

/** The answer's box as the filler sees it, drawn on the system field's own look; each type sets its own height and width. */
const FIELD = cn(INPUT_FIELD_CLASS, "mt-2 block bg-background");

/** The answer's place as the filler sees it; a choice's options, editable in place while he edits the question. */
function Field({ q, was, proposed, editing, onChange }: { q: FormQuestion; was?: FormQuestion; proposed?: boolean; editing: boolean; onChange(q: FormQuestion): void }) {
  if (q.type === "short") return <div data-field className={cn(FIELD, "h-8 max-w-[360px]")} />;
  if (q.type === "long") return <div data-field className={cn(FIELD, "h-[72px]")} />;
  if (editing) return <OptionsEdit q={q} onChange={onChange} />;
  // At rest a dropdown is the filler's closed box; a proposed one lists its choices, so a change to them can be seen.
  if (q.type === "dropdown" && !proposed)
    return (
      <div data-field className={cn(FIELD, "flex h-8 max-w-[200px] items-center justify-between py-0 ps-3 pe-2 text-muted-foreground")}>
        Choose
        <ChevronDown className="size-3" />
      </div>
    );
  const options = was ? optionDiff(was.options, q.options) : (q.options ?? []).map((text) => ({ text, mark: undefined }));
  return (
    <div data-field className="mt-1.5 flex flex-col">
      {options.map((o) => (
        <div key={`${o.text}${o.mark ?? ""}`} className="flex min-h-7 items-start gap-2 py-1 text-sm leading-5">
          <i aria-hidden className={`mt-[3px] size-3.5 shrink-0 ring-[1.5px] ring-foreground/40 ring-inset ${q.type === "dropdown" ? "rounded-sm" : "rounded-full"}`} />
          <span data-option={o.mark ?? ""} className={o.mark === "add" ? "bg-(--add-bg) px-0.5" : o.mark === "del" ? "bg-(--del-bg) px-0.5 text-(--soft-foreground) line-through" : "px-0.5"}>{o.text}</span>
        </div>
      ))}
    </div>
  );
}

function OptionsEdit({ q, onChange }: { q: FormQuestion; onChange(q: FormQuestion): void }) {
  const options = q.options ?? [];
  const set = (next: string[]): void => onChange({ ...q, options: next });
  return (
    <div data-field className="mt-1.5 flex flex-col">
      {options.map((o, i) => (
        <div key={i} className="flex min-h-7 items-center gap-2">
          <i aria-hidden className={`size-3.5 shrink-0 ring-[1.5px] ring-foreground/40 ring-inset ${q.type === "choice" ? "rounded-full" : "rounded-sm"}`} />
          <Input
            aria-label={`Option ${i + 1}`}
            value={o}
            onChange={(e) => set(options.map((x, j) => (j === i ? e.target.value : x)))}
            className={`${IN_PLACE} -ms-2.5 h-7 min-w-0 flex-1 px-2.5 py-0 text-sm leading-5`}
          />
          {options.length > 1 ? (
            <Tip label="Remove option">
              <Button variant="ghost" size="icon-xs" aria-label={`Remove ${o || `option ${i + 1}`}`} className="text-muted-foreground" onClick={() => set(options.filter((_, j) => j !== i))}>
                <X />
              </Button>
            </Tip>
          ) : null}
        </div>
      ))}
      <Button variant="ghost" size="xs" className="mt-1 -ms-2 self-start text-muted-foreground" onClick={() => set([...options, `Option ${options.length + 1}`])}>
        <Plus />
        Add option
      </Button>
    </div>
  );
}

function EditRow({ q, onChange }: { q: FormQuestion; onChange(q: FormQuestion | null): void }) {
  const TypeIcon = TYPE_ICONS[q.type];
  const retype = (type: FormQuestion["type"]): void => {
    const takes = type === "choice" || type === "dropdown";
    onChange({ ...q, type, options: takes ? (q.options?.length ? q.options : ["Option 1"]) : undefined });
  };
  return (
    <div className="mt-3 flex items-center gap-2 border-t border-border pt-2 text-xs text-muted-foreground" onClick={(e) => e.stopPropagation()}>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="xs" className="-ms-2" />}>
          <TypeIcon />
          {TYPE_WORDS[q.type]}
          <ChevronDown />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {(["short", "long", "choice", "dropdown"] as const).map((t) => {
            const Icon = TYPE_ICONS[t];
            return (
              <DropdownMenuItem key={t} onClick={() => retype(t)}>
                <Icon />
                {TYPE_WORDS[t]}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      <label className="ms-auto flex items-center gap-2">
        <Switch checked={q.required} aria-label="Required" onCheckedChange={(required) => onChange({ ...q, required })} />
        Required
      </label>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger render={<DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" aria-label="More" className="text-muted-foreground" />} />}>
            <MoreHorizontal />
          </TooltipTrigger>
          <TooltipContent>More</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => onChange(null)}>
            <Trash2 />
            Delete question
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// ── responses ────────────────────────────────────────────────────────

const POLL_MS = 10_000;

function useResponses(host: FormHost, live: boolean, attempt: number): FormResponses | null | "failed" {
  const [got, setGot] = useState<FormResponses | null | "failed">(null);
  useEffect(() => {
    if (!live) return;
    // A Retry starts from the bones again, not from the failure it answers.
    setGot((was) => (was === "failed" ? null : was));
    let on = true;
    let rev: number | undefined;
    const load = (): void =>
      void host.responses(rev).then(
        (r) => {
          if (!on || "same" in r) return;
          rev = r.rev;
          setGot(r);
        },
        () => on && setGot((was) => (was && was !== "failed" ? was : "failed")),
      );
    load();
    // New answers come from outside; the sheet's rev says when to read them again.
    const t = setInterval(load, POLL_MS);
    return () => {
      on = false;
      clearInterval(t);
    };
  }, [host, live, attempt]);
  return got;
}

function Responses({ view, host, store, item, shell }: { view: FormView; host: FormHost; store: FormStore; item: Props["item"]; shell: CanvasShell }) {
  const got = useResponses(host, view.state !== "draft", useSlot(store).responsesAttempt);
  // A read that failed with nothing shown is said once, on the state line with Retry (the body's status effect); a later failed poll keeps the last answers.
  const failed = got === "failed";
  useEffect(() => {
    store.set({ responsesError: failed ? "The sheet they are written to did not answer." : null });
    return () => store.set({ responsesError: null });
  }, [store, failed]);
  if (view.state === "draft") return <EmptyState title="No responses yet" />;
  if (failed) return null;
  if (!got) return <ResponsesSkeleton />;
  if (!got.count) return <EmptyState title="No responses yet" line={view.publishedAt ? `Published ${dayTime(view.publishedAt)}` : undefined} />;
  return <ResponseTable view={view} got={got} item={item} shell={shell} />;
}

function ResponseTable({ view, got, item, shell }: { view: FormView; got: FormResponses; item: Props["item"]; shell: CanvasShell }) {
  const last = submittedTime(got.rows[0]?.at(-1) ?? "");
  const q = chartQuestion(view.body);
  const bars = q ? answerBars(got, q) : [];
  const max = Math.max(1, ...bars.map((b) => b.count));
  const [picked, setPicked] = useState<ReadonlySet<number>>(new Set());
  const table = useRef<HTMLTableElement>(null);
  useEffect(() => {
    const el = table.current;
    if (!picked.size || !el) return shell.selection(null);
    const rows = [...picked].sort((a, b) => a - b).map((i) => got.rows[i]);
    const head = got.columns.map((c) => c.label).join("\t");
    shell.selection({
      chip: { kind: "selection", label: `${plural(rows.length, "response")}, ${view.body.title}`, ref: view.sheet ?? item.source, quote: [head, ...rows.map((r) => r.join("\t"))].join("\n") },
      rect: (el.querySelector("tr[data-picked]") ?? el).getBoundingClientRect(),
    });
    return () => shell.selection(null);
  }, [shell, picked, got, view.sheet, view.body.title, item.source]);
  const toggle = (i: number): void =>
    setPicked((was) => {
      const next = new Set(was);
      if (!next.delete(i)) next.add(i);
      return next;
    });
  const all = picked.size === got.rows.length;
  return (
    <div data-form-responses className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain">
      <p className="px-4 pt-3 text-[13px] leading-5 text-muted-foreground">
        {plural(got.count, "response")}
        {got.cut ? " shown, the newest; the sheet has them all" : ""}
        {last ? `, the last ${dayTime(last)}` : ""}
      </p>
      {q && bars.length ? (
        <div role="img" aria-label={`${q.label}: ${bars.map((b) => `${b.label} ${b.count}`).join(", ")}`} className="grid max-w-[560px] grid-cols-[minmax(0,max-content)_minmax(40px,1fr)_24px] items-center gap-x-3 gap-y-1.5 px-4 pt-3 pb-4 text-[13px] leading-5">
          <span className="col-span-full mb-0.5 font-medium">{q.label}</span>
          {bars.map((b) => (
            <BarRow key={b.label} label={b.label} count={b.count} max={max} />
          ))}
        </div>
      ) : null}
      <div className="border-t border-border">
        <DataTable ref={table} className="min-w-max leading-5">
          <TableHeader>
            <TableRow>
              <TableHead className="w-4 pe-0 first:pl-4">
                <Checkbox aria-label="Select all" checked={all} onCheckedChange={() => setPicked(all ? new Set() : new Set(got.rows.map((_, i) => i)))} />
              </TableHead>
              {got.columns.map((c, i) => (
                <TableHead key={c.id} className={`last:pr-4 ${i === got.columns.length - 1 ? "text-end" : ""}`}>
                  {c.label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {got.rows.map((r, i) => (
              <TableRow key={i} data-picked={picked.has(i) || undefined} className={picked.has(i) ? "bg-(--sel-bg)" : ""}>
                <TableCell className="w-4 pe-0 first:pl-4">
                  <Checkbox aria-label="Select" checked={picked.has(i)} onCheckedChange={() => toggle(i)} />
                </TableCell>
                {r.map((v, j) => (
                  <Cell key={j} last={j === r.length - 1}>
                    {j === r.length - 1 ? when(v) : v}
                  </Cell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </DataTable>
      </div>
    </div>
  );
}

const when = (v: string): string => {
  const t = submittedTime(v);
  return t === null ? v : dayTime(t);
};

function Cell({ last, children }: { last: boolean; children: ReactNode }) {
  return <TableCell className={`h-8 max-w-[320px] truncate last:pr-4 ${last ? "text-end text-muted-foreground" : ""}`}>{children}</TableCell>;
}

function BarRow({ label, count, max }: { label: string; count: number; max: number }) {
  return (
    <>
      <span className="min-w-0 truncate">{label}</span>
      <span className="h-2 origin-left rounded-e bg-(--chart-neutral)" style={{ width: `${(count / max) * 100}%` }} />
      <span className="text-end text-xs text-muted-foreground tabular-nums">{count}</span>
    </>
  );
}

// ── loading ──────────────────────────────────────────────────────────

export function FormSkeleton() {
  const pair = (
    <>
      <Skeleton className="mt-4 h-3 w-[30%]" />
      <Skeleton className="h-8 max-w-[360px]" />
    </>
  );
  return (
    <div data-form-loading aria-busy="true" className="mx-auto flex w-full max-w-[560px] flex-col gap-2.5 px-6 pt-6">
      <Skeleton className="h-5 w-[52%]" />
      <Skeleton className="h-3 w-[80%]" />
      {pair}
      {pair}
      {pair}
    </div>
  );
}

function ResponsesSkeleton() {
  return (
    <div aria-busy="true" className="flex flex-col gap-3 p-4">
      <Skeleton className="h-3 w-[40%]" />
      <Skeleton className="h-3 w-[90%]" />
      <Skeleton className="h-3 w-[90%]" />
      <Skeleton className="h-3 w-[90%]" />
    </div>
  );
}
