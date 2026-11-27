import { useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { MsApplyStage, MsFormResponses, MsFormView } from "@shared/contract-work-msforms";
import type { CanvasItem } from "@shared/work";
import { CHECK_WORDS, isOther, MSFORM_CHECKS, type MsFormCheck } from "@shared/work/msforms";
import { Check, Copy, ExternalLink, RefreshCw } from "../../chrome/icons";
import { BusyLabel, Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { Spinner } from "../../components/ui/spinner";
import { Tabs, TabsIndicator, TabsList, TabsTrigger, TABS_PILL_TRIGGER } from "../../components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip";
import { Tip, TruncateTip } from "../../components/tip";
import { mayMarkRevealRead, onRevealReadChange } from "../../lib/revealRead";
import { dayTime } from "../../lib/duration";
import { EmptyState } from "../../surfaces/SurfaceSkeleton";
import { sayError } from "../canvas/frame";
import { OpenFailed } from "../canvas/FetchState";
import type { CanvasBodyProps, CanvasShell, MoreEntry } from "../canvas/kind";
import { HALF_TAB, ResponsesSkeleton, ResponseTable } from "../forms/responses";
import { LiveBody } from "../office/live/LiveBody";
import { LiveCover } from "../office/live/cover";
import { liveAskUrl, liveLayer } from "../office/live/layer";
import { linkMsFormHost, type MsFormHost } from "./host";
import { QrDialog } from "./Share";
import { HistoryDialog } from "./History";
import { History, Mail, QrCode, Table } from "../icons";
import { openInFiles } from "../files/openFrom";
import { writeMail } from "../mail/mailto";
import { openWorkView } from "../../lib/workSwitch";
import { answerBarsOf, chartOf, timeColumnOf } from "./model";
import { NotAnsweredDialog } from "./NotAnswered";

/**
 * The Microsoft form kind (docs/agents/work-msforms.md "The fenced page";
 * docs/DESIGN.md "Microsoft form"): two halves switched in the bar. Form is
 * the real Forms builder in the Office-live guest, his own to edit; Responses
 * is the answers read from the workbook Forms keeps, drawn as our forms'
 * Responses are. Collect responses is held; the bar's press is his.
 */

export type Half = "form" | "responses";
export interface MsFormState {
  half: Half;
}

type Source = Extract<CanvasItem["source"], { at: "msform" }>;
type Props = CanvasBodyProps<MsFormState> & { host?: MsFormHost };

interface Slot {
  view: MsFormView | null;
  error: string | null;
  half: Half;
  busy: "collect" | "close" | "reopen" | null;
  /** the guest changed under him: the agent wrote while he was typing */
  changed: boolean;
  /** a dialog More opened */
  dialog: "history" | null;
}
class Store {
  private slot: Slot;
  private readonly listeners = new Set<() => void>();
  constructor(half: Half) {
    this.slot = { view: null, error: null, half, busy: null, changed: false, dialog: null };
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
const stores = new Map<string, Store>();
const storeOf = (itemId: string, half: Half = "form"): Store => {
  let s = stores.get(itemId);
  if (!s) stores.set(itemId, (s = new Store(half)));
  return s;
};
const hosts = new Map<string, MsFormHost>();
function hostFor(props: Props): MsFormHost {
  if (props.host) return props.host;
  const source = props.item.source as Source;
  const key = `${props.env}\n${source.workspaceId}\n${source.formId}`;
  let host = hosts.get(key);
  if (!host) hosts.set(key, (host = linkMsFormHost(props.env, source)));
  return host;
}
const useSlot = (store: Store): Slot => useSyncExternalStore(store.subscribe, store.get);

/** What the change line says while changes are written in Forms (`work.msforms.applying`), as the making line says a make's stage. */
export function applyStageWords(s: MsApplyStage): string {
  if (s.stage === "opening") return "Opening the form in Forms…";
  if (s.stage === "checking") return "Checking Accept responses…";
  if (s.stage === "reading") return "Reading the form back…";
  return s.of > 1 ? `Making change ${s.at} of ${s.of}…` : "Making the change…";
}

/** Where a write of this form's changes stands, while one runs. */
function useApplying(host: MsFormHost): MsApplyStage | null {
  const [stage, setStage] = useState<MsApplyStage | null>(null);
  useEffect(() => host.applying(setStage), [host]);
  return stage;
}

/** How long after his last key a change by the agent waits for his Reload instead of reloading the guest. */
export const TYPING_QUIET_MS = 10_000;

export function Body(props: Props) {
  const { item, shell, state, setState } = props;
  const host = hostFor(props);
  const store = storeOf(item.id, state?.half);
  const { view, error, half, changed } = useSlot(store);
  const cover = useContext(LiveCover);

  useEffect(() => {
    let on = true;
    void host.get().then(
      (v) => on && store.set({ view: v, error: null }),
      (err: unknown) => on && store.set({ error: err instanceof Error ? err.message : "The form could not be read." }),
    );
    return host.watch((v) => {
      if (!on) return;
      if (!v) return store.set({ error: "The form is not in this job any more." });
      store.set({ view: v });
    });
  }, [host, store]);

  // The half he left it on is kept for the item.
  useEffect(() => {
    if (state?.half !== half) setState({ half });
  }, [half, state?.half, setState]);

  useReloadOnChange(item.id, view, store);
  useChrome(shell, host, store, view, changed, item.id, props.env);
  const applying = useApplying(host);
  const current = useReview(shell, host, store, view, half, !!applying);
  useEffect(() => {
    shell.ready?.(!!view);
  }, [shell, view]);

  if (error && !view) return <OpenFailed kind="msform" why={error} onRetry={() => host.get().then((v) => store.set({ view: v, error: null }), () => undefined)} />;
  if (!view) return <FormBone />;
  if (half === "responses") return <Responses view={view} host={host} item={item} shell={shell} />;
  const waiting = view.suggestions[current];
  const why = waiting?.held ?? waiting?.reason;
  const guest = <LiveBody itemId={item.id} ask={{ forms: { tenant: view.tenant, formId: view.formId, page: "design" } }} app="forms" covered={cover.covered} full={cover.full} />;
  if (!waiting && !applying) return guest;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {applying ? (
        // While changes are written in Forms, the line says where it stands, in the making line's shape (Files' New → Form).
        <div data-msform-applying role="status" className="flex min-h-8 shrink-0 items-center gap-2 border-b border-border px-3 py-1 text-[13px] leading-5">
          <Spinner className="size-3 shrink-0" />
          <span className="min-w-0 truncate text-foreground">{applyStageWords(applying)}</span>
        </div>
      ) : waiting ? (
        // The change the stepper stands on, in words: Forms' own page cannot outline it.
        <div data-msform-change className="flex min-h-8 shrink-0 items-center gap-2 border-b border-border px-3 py-1 text-[13px] leading-5">
          <span className="min-w-0 truncate text-foreground">{waiting.words}</span>
          {/* Agent writes held it: why, before the agent's own reason; whole on hover when cut */}
          {why ? (
            <Tooltip>
              <TooltipTrigger render={<span className="min-w-0 truncate text-muted-foreground">{why}</span>} />
              <TooltipContent>
                <span className="min-w-0 break-words">{why}</span>
              </TooltipContent>
            </Tooltip>
          ) : null}
        </div>
      ) : null}
      {guest}
    </div>
  );
}

/**
 * An agent's waiting changes on the frame's stepper (docs/DESIGN.md "Microsoft form"): Accept runs the carrier's write
 * with exactly that change, Reject drops it, Accept all and Reject all take every one. Only on the Form half. While a
 * write runs in Forms (from any window, or an agent's), Reject and Accept rest in place until it ends, so no verdict is
 * sent on a list the write is changing; Previous and Next stay.
 */
function useReview(shell: CanvasShell, host: MsFormHost, store: Store, view: MsFormView | null, half: Half, writing: boolean): number {
  const [current, setCurrent] = useState(0);
  const suggestions = view?.suggestions;
  const at = suggestions?.length ? Math.min(current, suggestions.length - 1) : 0;
  useEffect(() => {
    if (!suggestions?.length || half !== "form") return shell.review(null);
    const ids = (w: number | { group: string } | "all"): string[] => (typeof w === "number" ? [suggestions[w]?.id].filter((x): x is string => !!x) : suggestions.map((s) => s.id));
    const decide = (accept: string[], reject: string[], failed: string): Promise<void> =>
      host.review(accept, reject).then(
        (v) => store.set({ view: v }),
        (err: unknown) => sayError(err, failed),
      );
    shell.review({
      groups: [{ id: "form", label: "Questions", by: suggestions[0]!.by, count: suggestions.length }],
      index: at,
      count: suggestions.length,
      step: setCurrent,
      verdictsHeld: writing,
      accept: (w) => decide(ids(w), [], "Couldn't make the change in Forms"),
      reject: (w) => decide([], ids(w), "Couldn't reject the change"),
    });
    return () => shell.review(null);
  }, [shell, host, store, suggestions, half, at, writing]);
  return at;
}

/**
 * His edits in the guest are his. When the agent's change lands (the rev moves), a guest he has not typed in for ten
 * seconds reloads; one he is typing in keeps his place, and the state line offers Reload.
 */
function useReloadOnChange(itemId: string, view: MsFormView | null, store: Store): void {
  const rev = useRef<number | null>(null);
  const keys = useRef({ count: 0, at: 0 });
  useEffect(() => {
    const t = setInterval(() => {
      void liveLayer.typed(itemId).then((n) => {
        if (n !== keys.current.count) keys.current = { count: n, at: Date.now() };
      });
    }, 2_000);
    return () => clearInterval(t);
  }, [itemId]);
  useEffect(() => {
    if (!view) return;
    const was = rev.current;
    rev.current = view.rev;
    if (was === null || view.rev <= was) return;
    if (Date.now() - keys.current.at > TYPING_QUIET_MS) liveLayer.retry(itemId);
    else store.set({ changed: true });
  }, [itemId, view, store]);
}

/** The mode, the state line and More, said to the frame for this form. */
function useChrome(shell: CanvasShell, host: MsFormHost, store: Store, view: MsFormView | null, changed: boolean, itemId: string, env: string): void {
  const state = view?.state;
  const mode = view?.mode;
  useEffect(() => {
    if (!mode) return shell.mode(null);
    if (state !== "draft") shell.mode({ value: "suggests", note: "The form takes answers, so every change waits for you" });
    else shell.mode({ value: mode, set: (next) => void host.mode(next).then((v) => store.set({ view: v }), (err: unknown) => sayError(err, "Couldn't change what the agent does")) });
    return () => shell.mode(null);
  }, [shell, host, store, mode, state]);

  const stopped = view?.stopped ?? null;
  useEffect(() => {
    if (changed) shell.statusLine({ tone: "quiet", word: "Changed by the agent", action: { label: "Reload", run: () => {
          liveLayer.retry(itemId);
          store.set({ changed: false });
        } } });
    else if (stopped) shell.statusLine({ tone: "failed", word: "Not finished", detail: stopped });
    else shell.statusLine(null);
    return () => shell.statusLine(null);
  }, [shell, store, changed, stopped, itemId]);

  const check = view?.check;
  const formId = view?.formId;
  const tenant = view?.tenant;
  const link = view?.link ?? null;
  const title = view?.title;
  const workspaceId = view?.workspaceId;
  const workbook = !!view?.workbook;
  useEffect(() => {
    if (!formId || !tenant) return shell.more?.(null);
    const entries: MoreEntry[] = [
      { id: "browser", label: "Open in Browser", icon: ExternalLink, run: () => void window.open(liveAskUrl({ forms: { tenant, formId, page: "design" } }), "_blank", "noopener") },
      ...(workbook && workspaceId
        ? [
            {
              id: "workbook",
              label: "Open the Workbook",
              icon: Table,
              // Excel for the web in a Files tab: the host remembers the file as Live, and Files seats it so.
              run: () =>
                void host
                  .workbook()
                  .then((file) => openInFiles({ id: workspaceId, environmentId: env }, file))
                  .catch((err: unknown) => sayError(err, "Couldn't open the workbook")),
            } satisfies MoreEntry,
          ]
        : []),
      { id: "history", label: "Question History…", icon: History, run: () => store.set({ dialog: "history" }) },
      ...(state !== "draft"
        ? MSFORM_CHECKS.map<MoreEntry>((every) => ({
            id: `check-${every}`,
            label: `Check for Answers: ${CHECK_WORDS[every]}`,
            icon: every === check ? Check : RefreshCw,
            disabled: every === check,
            run: () => void host.check(every as MsFormCheck).then((v) => store.set({ view: v })),
          }))
        : []),
      ...(state === "collecting" && link
        ? [
            {
              id: "mail",
              label: "Mail the Link…",
              icon: Mail,
              // Mail's composer opens with the link in it; the send is his, held as every mail is.
              run: () => {
                writeMail({ to: [], cc: [], bcc: [], subject: title ?? "", body: `${title ?? "A form"}: ${link}` }, workspaceId);
                if (workspaceId) openWorkView({ workspaceId, view: "mail" });
              },
            } satisfies MoreEntry,
          ]
        : []),
    ];
    shell.more?.(entries);
    return () => shell.more?.(null);
  }, [shell, host, store, formId, tenant, state, check, link, title, workspaceId, workbook, env]);
}

// ── the bar ──────────────────────────────────────────────────────────

export function Bar(props: Props) {
  const host = hostFor(props);
  const store = storeOf(props.item.id, props.state?.half);
  const { view, error, half, busy, dialog } = useSlot(store);
  // While the form loads the bar holds one bone where the switch will be, so the body never moves under it.
  if (!view) return error ? null : <Skeleton data-msform-bar-bone className="h-3 w-30" />;
  const press = (which: "collect" | "close" | "reopen", run: () => Promise<MsFormView>, failed: string): void => {
    store.set({ busy: which });
    void run().then(
      (v) => store.set({ view: v, busy: null }),
      (err: unknown) => {
        store.set({ busy: null });
        sayError(err, failed);
      },
    );
  };
  const waiting = view.suggestions.length;
  return (
    <>
      <Tabs value={half} onValueChange={(next) => store.set({ half: next as Half })} className="mx-1 shrink-0 gap-0">
        <TabsList aria-label="Form view" className="relative p-0.5 group-data-[orientation=horizontal]/tabs:h-6">
          <TabsIndicator />
          <TabsTrigger value="form" className={`${TABS_PILL_TRIGGER} ${HALF_TAB}`}>
            Form
          </TabsTrigger>
          <TabsTrigger value="responses" className={`${TABS_PILL_TRIGGER} ${HALF_TAB}`}>
            Responses
            {view.unseen ? <span className="text-muted-foreground tabular-nums">{view.unseen}</span> : null}
          </TabsTrigger>
        </TabsList>
      </Tabs>
      {waiting ? null : view.state === "draft" ? (
        <Button data-msform-collect size="xs" className="ms-auto" disabled={busy !== null || !view.questions.some((q) => isOther(q) || q.type !== "section")} onClick={() => press("collect", () => host.collect(), "Couldn't collect responses")}>
          <BusyLabel busy={busy === "collect"} label="Collect responses" />
        </Button>
      ) : view.state === "collecting" && view.link ? (
        <Link link={view.link} title={view.title} closing={busy === "close"} close={() => press("close", () => host.close(false), "Couldn't close the form")} />
      ) : view.state === "closed" ? (
        <span data-msform-closed className="ms-auto flex min-w-0 items-center gap-1">
          <span className="min-w-0 truncate text-xs text-muted-foreground">{view.closedAt ? `Closed ${dayTime(view.closedAt)}` : "Closed"}</span>
          <Button variant="ghost" size="xs" disabled={busy !== null} onClick={() => press("reopen", () => host.close(true), "Couldn't reopen the form")}>
            <BusyLabel busy={busy === "reopen"} label="Reopen" />
          </Button>
        </span>
      ) : null}
      {dialog === "history" ? <HistoryDialog title={view.title} load={host.history} onClose={() => store.set({ dialog: null })} /> : null}
    </>
  );
}

/** The response link in `link` blue with Copy and Close form, as our form's live link; the address gives way to a worded Copy link in a narrow bar. */
function Link({ link, title, closing, close }: { link: string; title: string; closing: boolean; close(): void }) {
  const [copied, setCopied] = useState(false);
  const [qr, setQr] = useState(false);
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
    <span data-msform-link className="ms-auto flex min-w-0 items-center gap-1">
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
      <Button variant="ghost" size="xs" onClick={copy} className="hidden @max-[600px]/bar:inline-flex">
        {copied ? <Check /> : <Copy />}
        {copied ? "Copied" : "Copy link"}
      </Button>
      <Tip label="QR code">
        <Button variant="ghost" size="icon-xs" aria-label="QR code" onClick={() => setQr(true)} className="text-muted-foreground @max-[600px]/bar:text-foreground">
          <QrCode />
        </Button>
      </Tip>
      <Button variant="ghost" size="xs" disabled={closing} onClick={close}>
        <BusyLabel busy={closing} label="Close form" />
      </Button>
      {qr ? <QrDialog link={link} title={title} onClose={() => setQr(false)} /> : null}
    </span>
  );
}

// ── responses ────────────────────────────────────────────────────────

/** An answer read older than this says "As of" once in the summary line. */
const OLD_MS = 2 * 60_000;

function Responses({ view, host, item, shell }: { view: MsFormView; host: MsFormHost; item: CanvasItem; shell: CanvasShell }) {
  const [got, setGot] = useState<MsFormResponses | null | "failed">(null);
  const [refreshing, setRefreshing] = useState(false);
  const [asking, setAsking] = useState(false);
  const count = view.count;
  useEffect(() => {
    let on = true;
    void host.responses().then(
      (r) => on && setGot(r),
      () => on && setGot((was) => (was && was !== "failed" ? was : "failed")),
    );
    return () => {
      on = false;
    };
  }, [host, count]);
  const maySee = useSyncExternalStore(onRevealReadChange, mayMarkRevealRead);
  useEffect(() => {
    if (maySee && mayMarkRevealRead()) void host.seen().catch(() => undefined);
  }, [host, count, maySee]);
  const chart = useMemo(() => (got && got !== "failed" ? chartOf(view.questions, got) : null), [got, view.questions]);
  // The addresses the answers carry (Record name on): who hasn't answered is read against them.
  const answered = useMemo(() => {
    if (!got || got === "failed") return null;
    const at = got.columns.findIndex((c) => c.id === "email");
    return at < 0 ? null : got.rows.map((r) => r[at] ?? "").filter(Boolean);
  }, [got]);
  const refresh = (): void => {
    setRefreshing(true);
    void host
      .refresh()
      .then(() => host.responses())
      .then(
        (r) => setGot(r),
        (err: unknown) => sayError(err, "Couldn't read the answers"),
      )
      .finally(() => setRefreshing(false));
  };
  if (view.state === "draft") return <EmptyState title="Not collecting responses" />;
  if (got === "failed") return <OpenFailed kind="msform" why="The workbook Forms keeps the answers in could not be read." onRetry={refresh} />;
  if (!got) return <ResponsesSkeleton />;
  if (got.none || !got.count) return <EmptyState title="No responses yet" action={{ label: refreshing ? "Reading…" : "Refresh", onClick: refresh }} />;
  const old = got.at !== null && Date.now() - got.at > OLD_MS;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ResponseTable
        title={view.title}
        got={{ ...got, rows: got.rows }}
        chart={chart ? { label: chart.label, bars: answerBarsOf(got, chart) } : null}
        chipRef={item.source}
        shell={shell}
        timeColumn={timeColumnOf(got)}
        whole="the workbook has them all"
        asOf={got.stale || old ? `as of ${dayTime(got.at ?? Date.now())}` : null}
        aside={
          answered ? (
            <Button data-msform-not-answered variant="ghost" size="xs" className="-my-0.5 shrink-0 text-muted-foreground" onClick={() => setAsking(true)}>
              Who hasn't answered
            </Button>
          ) : null
        }
      />
      {asking && answered ? <NotAnsweredDialog env={item.source.at === "msform" ? item.source.host : ""} workspaceId={view.workspaceId} answered={answered} onClose={() => setAsking(false)} /> : null}
    </div>
  );
}

function FormBone() {
  return (
    <div data-msform-loading aria-busy="true" className="mx-auto flex w-full max-w-[560px] flex-col gap-2.5 px-6 pt-6">
      <Skeleton className="h-5 w-[52%]" />
      <Skeleton className="h-3 w-[80%]" />
      <Skeleton className="mt-4 h-8 max-w-[360px]" />
      <Skeleton className="h-8 max-w-[360px]" />
    </div>
  );
}
