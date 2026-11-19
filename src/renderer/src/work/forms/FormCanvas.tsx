import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { FormBody, FormQuestion, FormResponses, FormView } from "@shared/contract-work-forms";
import { Check, ChevronDown, CircleDot, Copy, FileText, MoreHorizontal, Plus, TextCursor, Trash2, X, CaseSensitive } from "../../chrome/icons";
import { BusyLabel, Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../components/ui/dropdown-menu";
import { Skeleton } from "../../components/ui/skeleton";
import { Switch } from "../../components/ui/switch";
import { Tabs, TabsIndicator, TabsList, TabsTrigger, TABS_PILL_TRIGGER } from "../../components/ui/tabs";
import { dayTime } from "../../lib/duration";
import { EmptyState } from "../../surfaces/SurfaceSkeleton";
import { sayError } from "../canvas/frame";
import type { CanvasBodyProps, CanvasShell, ReviewAdapter } from "../canvas/kind";
import { Table } from "../icons";
import { linkFormHost, type FormHost } from "./host";
import { answerBars, chartQuestion, newId, optionDiff, plural, shownQuestions, submittedTime, TYPE_WORDS, type Shown } from "./model";

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
}
class FormStore {
  private slot: Slot;
  private readonly listeners = new Set<() => void>();
  constructor(half: Half) {
    this.slot = { view: null, error: null, half, publishing: false };
  }
  get = (): Slot => this.slot;
  set = (patch: Partial<Slot>): void => {
    this.slot = { ...this.slot, ...patch };
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
  }, [host, store]);
  useEffect(() => {
    if (state?.half !== half) setState({ half });
  }, [half, state?.half, setState]);

  const [current, setCurrent] = useState(0);
  useFeeds(shell, host, store, view, current, setCurrent);

  if (error) return <EmptyState title="Couldn't open this form" line={error} />;
  if (!view) return <FormSkeleton />;
  return (
    <div data-form className="flex min-h-0 min-w-0 flex-1 flex-col">
      {view.state === "closed" && view.closedAt ? <ClosedLine at={view.closedAt} reopen={() => run(host.close(true), store, "Couldn't reopen the form")} /> : null}
      {half === "questions" ? (
        <Questions key={view.itemId} view={view} host={host} store={store} current={view.suggestions.length ? current : -1} onStep={setCurrent} />
      ) : (
        <Responses view={view} host={host} item={props.item} shell={shell} />
      )}
    </div>
  );
}

const run = (work: Promise<FormView>, store: FormStore, fallback: string): Promise<void> =>
  work.then(
    (v) => store.set({ view: v }),
    (e: unknown) => sayError(e, fallback),
  );

/** What the body tells the pane: the mode, the stepper over waiting changes, the line after a direct write, More's own rows. */
function useFeeds(shell: CanvasShell, host: FormHost, store: FormStore, view: FormView | null, current: number, setCurrent: (n: number) => void): void {
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
  useEffect(() => {
    if (!suggestions?.length) return shell.review(null);
    const ids = (w: number | { group: string } | "all"): { ids: string[] } | "all" => (typeof w === "number" ? { ids: [suggestions[w]?.id].filter(Boolean) } : "all");
    const index = Math.min(current, suggestions.length - 1);
    const review: ReviewAdapter = {
      groups: [{ id: "form", label: "Questions", by: suggestions[0].by, count: suggestions.length }],
      index,
      count: suggestions.length,
      step: (to) => setCurrent(to),
      accept: (w) => run(host.review(ids(w), "accept"), store, "Couldn't accept the change"),
      reject: (w) => run(host.review(ids(w), "reject"), store, "Couldn't reject the change"),
    };
    shell.review(review);
    return () => shell.review(null);
  }, [shell, host, store, suggestions, current, setCurrent]);

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
  const { view, half, publishing } = useSlot(store);
  if (!view) return null;
  const publish = (): void => {
    store.set({ publishing: true });
    void run(host.publish(), store, "Couldn't publish the form").finally(() => store.set({ publishing: false }));
  };
  return (
    <>
      <Tabs value={half} onValueChange={(next) => store.set({ half: next as Half })} className="mx-1 shrink-0 gap-0">
        <TabsList aria-label="Half" className="h-6 p-0.5">
          <TabsIndicator />
          <TabsTrigger value="questions" className={`${TABS_PILL_TRIGGER} px-2 text-xs`}>
            Questions
          </TabsTrigger>
          <TabsTrigger value="responses" className={`${TABS_PILL_TRIGGER} px-2 text-xs`}>
            Responses
          </TabsTrigger>
        </TabsList>
      </Tabs>
      {view.suggestions.length ? null : view.state === "draft" ? (
        <Button size="xs" className="ms-auto" disabled={publishing} onClick={publish}>
          <BusyLabel busy={publishing} label="Publish" />
        </Button>
      ) : view.state === "open" && view.link ? (
        <LiveLink link={view.link} close={() => run(host.close(false), store, "Couldn't close the form")} />
      ) : null}
    </>
  );
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
  return (
    <span data-form-link className="ms-auto flex min-w-0 items-center gap-1">
      <a href={link} target="_blank" rel="noreferrer" className="min-w-0 truncate text-xs text-accent underline-offset-3 hover:underline">
        {shown}
      </a>
      <Button variant="ghost" size="icon-xs" aria-label={copied ? "Copied" : "Copy link"} onClick={copy} className="text-muted-foreground">
        {copied ? <Check /> : <Copy />}
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
 * when it was typed). A save that fails drops only the edit it carried. A
 * pending edit is sent at once when the half closes.
 */
function useSaver(host: FormHost, store: FormStore, setEdits: (f: (now: FormBody | null) => FormBody | null) => void): { later(next: FormBody): void } {
  const state = useRef<{ timer: ReturnType<typeof setTimeout> | null; waiting: FormBody | null; busy: boolean; queued: FormBody | null } | null>(null);
  state.current ??= { timer: null, waiting: null, busy: false, queued: null };
  const s = state.current;
  const send = useCallback(
    (next: FormBody): void => {
      if (s.busy) {
        s.queued = next;
        return;
      }
      const rev = store.get().view?.rev;
      if (rev === undefined) return;
      s.busy = true;
      host
        .save(rev, next)
        .then(
          (v) => store.set({ view: v }),
          (e: unknown) => sayError(e, "Couldn't save the form"),
        )
        .finally(() => {
          setEdits((now) => (now === next ? null : now));
          s.busy = false;
          const queued = s.queued;
          s.queued = null;
          if (queued) send(queued);
        });
    },
    [host, store, setEdits, s],
  );
  useEffect(
    () => () => {
      if (!s.timer || !s.waiting) return;
      clearTimeout(s.timer);
      s.timer = null;
      send(s.waiting);
    },
    [s, send],
  );
  return {
    later(next) {
      s.waiting = next;
      if (s.timer) clearTimeout(s.timer);
      s.timer = setTimeout(() => {
        s.timer = null;
        s.waiting = null;
        send(next);
      }, SAVE_AFTER);
    },
  };
}

function Questions({ view, host, store, current, onStep }: { view: FormView; host: FormHost; store: FormStore; current: number; onStep(n: number): void }) {
  // His edits stand over the host's view until the save that carries them answers.
  const [edits, setEdits] = useState<FormBody | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const saver = useSaver(host, store, setEdits);
  const body = edits ?? view.body;
  const editable = view.state !== "closed";
  const edit = (next: FormBody): void => {
    setEdits(next);
    saver.later(next);
  };

  const shown = useMemo(() => shownQuestions(body, edits ? [] : view.suggestions), [body, edits, view.suggestions]);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (current >= 0) list.current?.querySelector(`[data-change="${current}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [current]);

  const setQuestion = (id: string, q: FormQuestion | null): void =>
    edit({ ...body, questions: q ? body.questions.map((x) => (x.id === id ? q : x)) : body.questions.filter((x) => x.id !== id) });
  const add = (): void => {
    const q: FormQuestion = { id: newId(), label: "Question", type: "short", required: false };
    edit({ ...body, questions: [...body.questions, q] });
    setFocus(q.id);
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
                onFocus={() => {
                  if (s.change !== undefined) onStep(s.change);
                  else setFocus(s.q.id);
                }}
                onChange={(q) => setQuestion(s.q.id, q)}
              />
            ))}
          </div>
          {editable ? (
            <Button variant="ghost" size="sm" className="mt-2 ms-1 text-muted-foreground" onClick={add}>
              <Plus />
              Add question
            </Button>
          ) : null}
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
        <button
          key={s.q.id}
          type="button"
          onClick={() => document.getElementById(`fq-${s.q.id}`)?.scrollIntoView({ block: "start" })}
          className="h-7 truncate rounded-md px-2 text-start text-[13px] text-muted-foreground transition-[background-color,color] duration-(--dur-hover) hover:bg-foreground/5 hover:text-foreground"
        >
          {s.q.label}
        </button>
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
  const shared = `block w-full resize-none rounded-md border-0 bg-transparent placeholder:text-muted-foreground/70 ${className}`;
  return multiline ? (
    <textarea aria-label={label} rows={1} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} className={`${shared} field-sizing-content`} />
  ) : (
    <input aria-label={label} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} className={shared} />
  );
}

const TYPE_ICONS = { short: TextCursor, long: FileText, choice: CircleDot, dropdown: ChevronDown, section: CaseSensitive } as const;

function QuestionBlock({
  shown,
  focused,
  current,
  editable,
  onFocus,
  onChange,
}: {
  shown: Shown;
  focused: boolean;
  current: boolean;
  editable: boolean;
  onFocus(): void;
  onChange(q: FormQuestion | null): void;
}) {
  const { q, mark, was } = shown;
  const tint = mark === "add" ? "bg-(--add-bg)" : mark === "del" ? "bg-(--del-bg)" : focused ? "bg-muted" : "hover:bg-foreground/4";
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
      <div id={`fq-${q.id}`} data-q={q.id} data-change={shown.change} onClick={onFocus} className={`mt-5 rounded-xl px-3 py-1 transition-[background-color] duration-(--dur-hover) ${tint} ${outline}`}>
        {focused && editable ? (
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
      onClick={onFocus}
      className={`rounded-xl p-3 transition-[background-color] duration-(--dur-hover) ${tint} ${outline}`}
    >
      {focused && editable ? (
        <input
          aria-label="Question"
          autoFocus
          value={q.label}
          onChange={(e) => onChange({ ...q, label: e.target.value })}
          className="block w-full rounded-md border-0 bg-transparent text-sm leading-5 font-medium"
        />
      ) : (
        <div className="text-sm leading-5 font-medium">
          {label}
          {q.required && mark !== "del" ? <span className="text-muted-foreground"> *</span> : null}
        </div>
      )}
      <Field q={q} was={mark === "change" ? was : undefined} editing={focused && editable} onChange={onChange} />
      {focused && editable ? <EditRow q={q} onChange={onChange} /> : null}
    </div>
  );
}

function SectionEdit({ q, onChange }: { q: FormQuestion; onChange(q: FormQuestion | null): void }) {
  return (
    <div className="flex items-center gap-2">
      <input
        aria-label="Section"
        autoFocus
        value={q.label}
        onChange={(e) => onChange({ ...q, label: e.target.value })}
        className="block min-w-0 flex-1 rounded-md border-0 bg-transparent text-base leading-6 font-semibold tracking-[-0.01em]"
      />
      <Button variant="ghost" size="icon-xs" aria-label="Delete section" className="text-muted-foreground" onClick={() => onChange(null)}>
        <Trash2 />
      </Button>
    </div>
  );
}

const FIELD = "mt-2 h-8 max-w-[360px] rounded-lg border border-input bg-background";

/** The answer's place as the filler sees it; a choice's options, editable in place while he edits the question. */
function Field({ q, was, editing, onChange }: { q: FormQuestion; was?: FormQuestion; editing: boolean; onChange(q: FormQuestion): void }) {
  if (q.type === "short") return <div data-field className={FIELD} />;
  if (q.type === "long") return <div data-field className={`${FIELD} h-[72px] max-w-none`} />;
  if (editing) return <OptionsEdit q={q} onChange={onChange} />;
  if (q.type === "dropdown")
    return (
      <div data-field className={`${FIELD} flex max-w-[200px] items-center justify-between ps-3 pe-2 text-[13px] text-muted-foreground`}>
        Choose
        <ChevronDown className="size-3" />
      </div>
    );
  const options = was ? optionDiff(was.options, q.options) : (q.options ?? []).map((text) => ({ text, mark: undefined }));
  return (
    <div data-field className="mt-1.5 flex flex-col">
      {options.map((o) => (
        <div key={`${o.text}${o.mark ?? ""}`} className="flex min-h-7 items-start gap-2 py-1 text-sm leading-5">
          <i aria-hidden className="mt-[3px] size-3.5 shrink-0 rounded-full ring-[1.5px] ring-foreground/40 ring-inset" />
          <span className={o.mark === "add" ? "bg-(--add-bg) px-0.5" : o.mark === "del" ? "bg-(--del-bg) px-0.5 text-muted-foreground line-through" : "px-0.5"}>{o.text}</span>
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
          <input
            aria-label={`Option ${i + 1}`}
            value={o}
            onChange={(e) => set(options.map((x, j) => (j === i ? e.target.value : x)))}
            className="min-w-0 flex-1 rounded-md border-0 bg-transparent text-sm leading-5"
          />
          {options.length > 1 ? (
            <Button variant="ghost" size="icon-xs" aria-label={`Remove ${o || `option ${i + 1}`}`} className="text-muted-foreground" onClick={() => set(options.filter((_, j) => j !== i))}>
              <X />
            </Button>
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
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" aria-label="More" className="text-muted-foreground" />}>
          <MoreHorizontal />
        </DropdownMenuTrigger>
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

function useResponses(host: FormHost, live: boolean): FormResponses | null | "failed" {
  const [got, setGot] = useState<FormResponses | null | "failed">(null);
  useEffect(() => {
    if (!live) return;
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
  }, [host, live]);
  return got;
}

function Responses({ view, host, item, shell }: { view: FormView; host: FormHost; item: Props["item"]; shell: CanvasShell }) {
  const got = useResponses(host, view.state !== "draft");
  if (view.state === "draft") return <EmptyState title="No responses yet" />;
  if (got === "failed") return <EmptyState title="Couldn't read the responses" line="The sheet they are written to did not answer." />;
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
      <div className="overflow-x-auto overflow-y-hidden border-t border-border">
        <table ref={table} className="w-full min-w-max text-[13px] leading-5">
          <thead>
            <tr className="border-b border-border">
              <th className="w-4 ps-4 pe-0">
                <Checkbox aria-label="Select all" checked={all} onCheckedChange={() => setPicked(all ? new Set() : new Set(got.rows.map((_, i) => i)))} />
              </th>
              {got.columns.map((c, i) => (
                <th key={c.id} className={`h-8 px-3 text-xs font-medium whitespace-nowrap text-muted-foreground last:pe-4 ${i === got.columns.length - 1 ? "text-end" : "text-start"}`}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {got.rows.map((r, i) => (
              <tr key={i} data-picked={picked.has(i) || undefined} className={`border-b border-border ${picked.has(i) ? "bg-(--sel-bg)" : ""}`}>
                <td className="w-4 ps-4 pe-0">
                  <Checkbox aria-label="Select" checked={picked.has(i)} onCheckedChange={() => toggle(i)} />
                </td>
                {r.map((v, j) => (
                  <Cell key={j} last={j === r.length - 1}>
                    {j === r.length - 1 ? when(v) : v}
                  </Cell>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const when = (v: string): string => {
  const t = submittedTime(v);
  return t === null ? v : dayTime(t);
};

function Cell({ last, children }: { last: boolean; children: ReactNode }) {
  return <td className={`h-8 max-w-[320px] truncate px-3 whitespace-nowrap ${last ? "pe-4 text-end text-muted-foreground tabular-nums" : ""}`}>{children}</td>;
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
