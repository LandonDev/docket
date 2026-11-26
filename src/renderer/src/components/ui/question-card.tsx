import { DUR, EASE_EXIT, EASE_OUT } from "@renderer/lib/ease";
import { chordKey, keyCaps, modOrCtrl } from "@renderer/lib/keys";
import { AnimatePresence, motion, MotionConfig, type Variants } from "motion/react";
import { useReducedMotion } from "../../lib/motion";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@renderer/lib/cn";
import { Check } from "@renderer/chrome/icons";
import { Button } from "./button";
import { HeldTip } from "../heldTip";
import { Kbd, KbdGroup } from "./kbd";

/** The submit chord as caps: ⌘ ⏎ on a Mac, Ctrl Enter elsewhere. */
const SUBMIT_CAPS = keyCaps("mod+enter");

/**
 * A question an agent needs answered before it continues: one question at
 * a time, lettered options (A, B, C…) with an optional description line
 * under each, a free-form option that opens a field, Back / Skip / Next,
 * ⌘⏎ to continue. A `multiSelect` question takes several options and one
 * submit. Keys work only while focus is inside the card, so ⌘⏎ in the
 * composer never submits it. With more than one question (`showProgress`)
 * the title row ends with where the person is ("2 of 3"); a question with a
 * `header` of its own titles the card while it is shown, so no label trails
 * its prompt. A `multiSelect` question's caps wear a hairline at rest and
 * turn to a check when picked, so it reads as several at a glance. The caller's status
 * glyph goes in `icon`, flat beside the title. Answers come back as one array
 * of labels per question (the typed text for a free-form pick). The free-form
 * row's field sits beside its toggle, never inside it, so typing never unpicks it.
 */
export type QuestionOption = { label: string; description?: string; freeform?: boolean };
export type Question = { prompt: string; header?: string; options: Array<QuestionOption>; multiSelect?: boolean };

const KEYS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Next cross-fades the questions in place: the arriving one over
 *  --dur-base, the leaving one out over --dur-fast, opacity alone. */
const PAGE_MOVE = "flex flex-col transition-opacity motion-reduce:duration-(--dur-fast)";

const PAGE_REST = {
  current: "relative opacity-100 duration-(--dur-base) ease-(--ease-out)",
  away: "absolute inset-x-0 top-0 opacity-0 duration-(--dur-fast) ease-(--ease-exit)",
} as const;

/** The frame reaches past the page by 12px, so a hovered option or a focus ring is never cut. */
const PAGE_INSET = 12;

/** The pages, one shown. The frame's height follows the shown page over
 *  --dur-base: the card is the last thing above the composer, so the glide
 *  moves nothing above it (the transcript's anchor sits above the card). */
function MorphFrame({ at, children }: { at: number; children: Array<ReactNode> }) {
  const [height, setHeight] = useState<number>();
  const pages = useRef<Array<HTMLDivElement | null>>([]);
  useEffect(() => {
    const page = pages.current[at];
    if (!page) return;
    // A page not laid out (a hidden pane, a static render) reads 0: the frame keeps its natural height then.
    const read = () => setHeight(page.offsetHeight || undefined);
    read();
    const observer = new ResizeObserver(read);
    observer.observe(page);
    return () => observer.disconnect();
  }, [at]);
  return (
    <div
      data-slot="question-pages"
      className="-m-3 overflow-hidden p-3 transition-[height] duration-(--dur-base) ease-(--ease-out) motion-reduce:transition-none"
      style={{ height: height === undefined ? undefined : height + PAGE_INSET * 2 }}
    >
      <div className="relative">
        {children.map((page, index) => (
          <div
            key={index}
            ref={(node) => {
              pages.current[index] = node;
            }}
            data-page={index === at ? "current" : "away"}
            inert={index !== at}
            className={cn(PAGE_MOVE, index === at ? PAGE_REST.current : PAGE_REST.away)}
          >
            {page}
          </div>
        ))}
      </div>
    </div>
  );
}

const LABEL_IN = { duration: DUR.fast, ease: EASE_OUT } as const;
const LABEL_OUT = { duration: DUR.fast, ease: EASE_EXIT } as const;

/** A button's words changing: the width changes at once and the words swap on opacity alone. */
function MorphLabel({ children }: { children: ReactNode }) {
  return (
    <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: LABEL_OUT }} transition={LABEL_IN} className="inline-flex whitespace-nowrap">
      {children}
    </motion.span>
  );
}

/** Back arrives at the group's start, so Skip and Next never move. */
const BACK: Variants = {
  hidden: { opacity: 0, transform: "translateX(-8px)", transition: { duration: DUR.fast, ease: EASE_EXIT } },
  shown: { opacity: 1, transform: "translateX(0px)", transition: { duration: DUR.base, ease: EASE_OUT } },
};

/** An option: a flat 36px row (8px above and below the 20px line), its fill
 *  the one selected cue with the key cap; a press steps the fill at once. */
const OPTION = "flex min-h-9 w-full items-start gap-3 rounded-lg px-2 py-2 text-start active:bg-foreground/12";

export function QuestionCard({
  icon,
  title = "Questions",
  questions,
  onSubmitAnswers,
  onSkip,
  showProgress = questions.length > 1,
  held = null,
  whoCan = null,
  className,
}: {
  icon?: ReactNode;
  title?: string;
  questions: Array<Question>;
  onSubmitAnswers?: (answers: Array<Array<string>>) => void;
  onSkip?: () => void;
  /** "2 of 3" at the title row's end; off for a single question. */
  showProgress?: boolean;
  /** Why the answer cannot go now (the host away): Skip and Continue are held, this their tooltip. */
  held?: string | null;
  /** Who can answer, for a key that may not: said in Skip's and Continue's place; Back and Next stay so each question can be read. */
  whoCan?: string | null;
  className?: string;
}) {
  const id = useId();
  const motionRule = useReducedMotion() ? "always" : "never";
  const [at, setAt] = useState(0);
  const [picked, setPicked] = useState<Record<number, Array<number>>>({});
  const [typed, setTyped] = useState<Record<number, string>>({});

  const question = questions[at];
  const fields = useRef<Array<HTMLInputElement | null>>([]);
  const lists = useRef<Array<HTMLUListElement | null>>([]);

  const hasAnswer = (index: number) => {
    const choices = picked[index] ?? [];
    if (choices.length === 0) return false;
    const freeform = choices.some((choice) => questions[index]?.options[choice]?.freeform === true);
    return !freeform || choices.length > 1 || (typed[index]?.trim() ?? "") !== "";
  };
  // Read only, Next just turns the page: it waits on no pick.
  const answered = hasAnswer(at) || (!!whoCan && at < questions.length - 1);
  const last = at === questions.length - 1;

  const go = (by: number) => setAt((index) => Math.min(questions.length - 1, Math.max(0, index + by)));

  const back = () => {
    const to = Math.max(0, at - 1);
    go(-1);
    if (to !== 0) return;
    // Back leaves with the first question: focus the pick it holds, not the body.
    window.setTimeout(() => {
      const list = lists.current[0];
      (list?.querySelector<HTMLElement>('[aria-checked="true"]') ?? list?.querySelector<HTMLElement>("button"))?.focus();
    }, 0);
  };

  const pick = (index: number) => {
    const current = picked[at] ?? [];
    if (current.includes(index)) {
      setPicked((all) => ({ ...all, [at]: current.filter((choice) => choice !== index) }));
      return;
    }
    setPicked((all) => ({ ...all, [at]: question?.multiSelect ? [...current, index].sort((a, b) => a - b) : [index] }));
    if (question?.options[index]?.freeform) window.setTimeout(() => fields.current[at]?.focus(), 0);
  };

  /** A radio group's arrow: the choice moves with the focus, wrapping (the Other row's field takes it). */
  const move = (from: number, by: number) => {
    if (!question) return;
    const to = (from + by + question.options.length) % question.options.length;
    setPicked((all) => ({ ...all, [at]: [to] }));
    if (question.options[to]?.freeform) window.setTimeout(() => fields.current[at]?.focus(), 0);
    else lists.current[at]?.querySelectorAll<HTMLElement>('[role="radio"]')[to]?.focus();
  };

  const submit = () => {
    if (!answered) return;
    if (!last) {
      go(1);
      return;
    }
    if (held || whoCan) return;
    onSubmitAnswers?.(
      questions.map((entry, index) =>
        (picked[index] ?? []).map((choice) => (entry.options[choice]?.freeform ? (typed[index] ?? "") : (entry.options[choice]?.label ?? ""))),
      ),
    );
  };

  // Keys reach the card only from inside it: a letter picks, ⌘⏎ continues.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!question) return;
    if (event.key === "Enter" && modOrCtrl(event)) {
      event.preventDefault();
      submit();
      return;
    }
    const target = event.target;
    // One of several is one Tab stop: the arrows move the choice. In the Other field, Up and Down
    // still do (Left and Right keep the caret), so the keyboard is never shut in the field.
    const by = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
    if (by && !question.multiSelect && !chordKey(event)) {
      const field = target === fields.current[at];
      const from = field ? question.options.findIndex((option) => option.freeform) : [...(lists.current[at]?.querySelectorAll('[role="radio"]') ?? [])].indexOf(target as Element);
      if (from >= 0 && !(field && (event.key === "ArrowLeft" || event.key === "ArrowRight"))) {
        event.preventDefault();
        move(from, by);
        return;
      }
    }
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
    if (chordKey(event)) return;
    const letter = /^[a-z]$/i.test(event.key) ? event.key.toUpperCase() : undefined;
    const index = letter === undefined ? -1 : KEYS.indexOf(letter);
    if (index >= 0 && index < question.options.length) {
      event.preventDefault();
      pick(index);
    }
  };

  if (!question) return null;

  return (
    <div
      data-slot="question-card"
      role="group"
      aria-labelledby={`${id}-title`}
      onKeyDown={onKeyDown}
      className={cn("w-full max-w-lg rounded-xl border border-border bg-card p-4 font-sans text-card-foreground in-[.bg-card]:border-0 in-[.bg-card]:bg-transparent in-[.bg-card]:p-0", className)}
    >
      <div className="flex min-h-5 items-center gap-2">
        {icon ? <span className="flex shrink-0">{icon}</span> : null}
        <h3 id={`${id}-title`} className="min-w-0 truncate text-sm leading-5 font-medium text-foreground">
          {question.header ?? title}
        </h3>
        {showProgress ? (
          <span data-slot="question-progress" aria-live="polite" className="ms-auto shrink-0 text-xs leading-5 text-muted-foreground tabular-nums">
            {at + 1} of {questions.length}
          </span>
        ) : null}
      </div>

      <div className="mt-3">
        <MorphFrame at={at}>
          {questions.map((entry, qIndex) => {
            const choices = picked[qIndex] ?? [];
            // A radio group's one Tab stop: its choice, else its first row (multi-select rows are each a stop).
            const stop = entry.multiSelect ? -1 : (choices[0] ?? 0);
            return (
              <div key={entry.prompt}>
                <div aria-live="polite">
                  <p className="text-sm leading-[22px] text-foreground">{entry.prompt}</p>
                </div>
                <ul
                  ref={(node) => {
                    lists.current[qIndex] = node;
                  }}
                  // One of several is a radio group, several of several a group of checkboxes: a reader hears
                  // "radio, 2 of 4", never four unrelated toggle buttons. The rows keep their look and their keys.
                  role={entry.multiSelect ? "group" : "radiogroup"}
                  aria-label={entry.prompt}
                  className="-mx-2 mt-2 flex flex-col gap-1"
                >
                  {entry.options.map((option, index) => {
                    const active = choices.includes(index);
                    const role = entry.multiSelect ? "checkbox" : "radio";
                    const key = KEYS[index];
                    const optionId = `${id}-${qIndex}-${index}`;
                    const fill = active ? "bg-foreground/10" : "hover:bg-foreground/5";
                    const tabIndex = entry.multiSelect ? undefined : index === stop ? 0 : -1;
                    // The cap sits on the label's first line: 20px, the line's own height. A multi-select
                    // question's cap is a hairline box at rest and a check once picked: several, not one.
                    const cap = (
                      <span
                        aria-hidden
                        data-slot="question-key"
                        className={cn(
                          "pointer-events-none flex size-5 shrink-0 items-center justify-center rounded-sm text-[11px] leading-none font-medium tabular-nums",
                          active ? "bg-primary text-primary-foreground" : entry.multiSelect ? "border border-border text-muted-foreground" : "bg-foreground/7 text-muted-foreground",
                        )}
                      >
                        {active && entry.multiSelect ? <Check className="size-3" /> : key}
                      </span>
                    );
                    if (option.freeform) {
                      // The field is no child of the toggle: a button wrapping an input turns the
                      // field's Space and Enter into clicks that unpick the row. The toggle covers
                      // the row; the field rises above it once the row is picked.
                      return (
                        <li key={option.label} role="presentation">
                          {/* While its field holds the focus, the row wears the option's one ring (index.css), so the
                              caret is never the only cue; picked, the field is the group's Tab stop. */}
                          <div data-slot="question-option" className={cn("relative", OPTION, fill)}>
                            <button type="button" role={role} aria-checked={active} aria-label={option.label} tabIndex={active ? -1 : tabIndex} onClick={() => pick(index)} className="absolute inset-0 rounded-lg" />
                            {cap}
                            <input
                              ref={(node) => {
                                fields.current[qIndex] = node;
                              }}
                              value={typed[qIndex] ?? ""}
                              readOnly={!active}
                              tabIndex={active ? undefined : -1}
                              aria-label={option.label}
                              placeholder={option.label}
                              onChange={(event) => setTyped((all) => ({ ...all, [qIndex]: event.target.value }))}
                              className={cn(
                                "h-5 w-full bg-transparent text-sm leading-5 text-foreground outline-none placeholder:text-muted-foreground",
                                active && "relative",
                              )}
                            />
                          </div>
                        </li>
                      );
                    }
                    return (
                      <li key={option.label} role="presentation">
                        <button
                          type="button"
                          role={role}
                          data-slot="question-option"
                          tabIndex={tabIndex}
                          aria-checked={active}
                          aria-labelledby={`${optionId}-label`}
                          aria-describedby={option.description ? `${optionId}-description` : undefined}
                          onClick={() => pick(index)}
                          className={cn(OPTION, fill)}
                        >
                          {cap}
                          <span className="flex min-w-0 flex-col">
                            <span id={`${optionId}-label`} className="text-sm leading-5 text-foreground">
                              {option.label}
                            </span>
                            {option.description ? (
                              <span id={`${optionId}-description`} className="text-[13px] leading-5 text-muted-foreground">
                                {option.description}
                              </span>
                            ) : null}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </MorphFrame>
      </div>

      <div data-slot="question-actions" className="mt-4 flex min-h-7 items-center justify-end gap-2">
        {whoCan ? <span data-slot="question-who-can" className="me-auto min-w-0 text-pretty text-[13px] leading-5 text-muted-foreground">{whoCan}</span> : null}
        <MotionConfig reducedMotion={motionRule}>
          <AnimatePresence initial={false}>
            {at > 0 ? (
              <motion.span key="back" variants={BACK} initial="hidden" animate="shown" exit="hidden" className="flex">
                <Button variant="secondary" size="sm" onClick={back}>
                  Back
                </Button>
              </motion.span>
            ) : null}
          </AnimatePresence>
        </MotionConfig>
        {onSkip && !whoCan ? (
          <HeldTip held={held}>
            <Button variant="secondary" size="sm" disabled={!!held} onClick={onSkip}>
              Skip
            </Button>
          </HeldTip>
        ) : null}
        {/* Next only moves the card: only the last press, which sends, waits for the host. */}
        {whoCan && last ? null : (
        <HeldTip held={last ? held : null}>
        <Button size="sm" disabled={!answered || (last && !!held)} onClick={submit} className="gap-0">
          <MotionConfig reducedMotion={motionRule}>
            <AnimatePresence initial={false}>
              <MorphLabel key={last ? "continue" : "next"}>{last ? "Continue" : "Next"}</MorphLabel>
            </AnimatePresence>
          </MotionConfig>
          <KbdGroup className="ms-2">
            {SUBMIT_CAPS.map((cap) => (
              <Kbd key={cap} size="sm" className="justify-center border-transparent bg-background/15 text-current">
                {cap}
              </Kbd>
            ))}
          </KbdGroup>
        </Button>
        </HeldTip>
        )}
      </div>
    </div>
  );
}
