import type { FormBody, FormQuestion, FormResponses, FormSuggestion } from "@shared/contract-work-forms";

/**
 * What the form canvas draws, worked out from the host's view
 * (docs/agents/work-forms.md "The canvas"). Pure, so the tests read it.
 */

/** A question as shown: as it stands, or as a waiting change would make it. */
export interface Shown {
  q: FormQuestion;
  /** add: a question the change adds; del: one it removes; change: one it rewrites (`was` is how it reads now) */
  mark?: "add" | "del" | "change";
  was?: FormQuestion;
  /** the change's place in the stepper */
  change?: number;
}

export function shownQuestions(body: FormBody, suggestions: readonly FormSuggestion[]): Shown[] {
  const list: Shown[] = body.questions.map((q) => ({ q }));
  suggestions.forEach((s, change) => {
    if (s.op === "add") {
      const at = s.after == null ? 0 : list.findIndex((x) => x.q.id === s.after) + 1;
      list.splice(s.after != null && at === 0 ? list.length : at, 0, { q: s.question, mark: "add", change });
      return;
    }
    const i = list.findIndex((x) => x.q.id === s.question.id && x.mark !== "add");
    if (i < 0) return;
    list[i] = s.op === "remove" ? { ...list[i], mark: "del", change } : { q: s.question, was: list[i].q, mark: "change", change };
  });
  return list;
}

/** A changed choice's options: those it keeps, those it drops and those it adds, in reading order. */
export function optionDiff(was: readonly string[] = [], now: readonly string[] = []): { text: string; mark?: "add" | "del" }[] {
  const out: { text: string; mark?: "add" | "del" }[] = [];
  // A dropped option stands where it stood: before the first kept option that followed it.
  let next = 0;
  const dropUntil = (end: number): void => {
    for (; next < end; next++) if (!now.includes(was[next])) out.push({ text: was[next], mark: "del" });
  };
  for (const o of now) {
    const at = was.indexOf(o);
    if (at < 0) {
      out.push({ text: o, mark: "add" });
      continue;
    }
    dropUntil(at);
    next = Math.max(next, at + 1);
    out.push({ text: o });
  }
  dropUntil(was.length);
  return out;
}

export const TYPE_WORDS: Record<FormQuestion["type"], string> = {
  short: "Short answer",
  long: "Long answer",
  choice: "Choice",
  dropdown: "Dropdown",
  section: "Section",
};

/** When an answer came in, from the sheet's "2026-11-19 14:06" in the host's own time; null when it does not read. */
export function submittedTime(text: string): number | null {
  const m = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d)$/.exec(text.trim());
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime() : null;
}

/** The bars for one choice: each option's count, in the question's order, then any other answer the sheet holds. */
export function answerBars(responses: FormResponses, q: FormQuestion): { label: string; count: number }[] {
  const col = responses.columns.findIndex((c) => c.id === q.id);
  if (col < 0) return [];
  const counts = new Map<string, number>((q.options ?? []).map((o) => [o, 0]));
  for (const row of responses.rows) {
    const v = row[col];
    if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts].map(([label, count]) => ({ label, count }));
}

/** The question the responses' bars are drawn for: the form's first choice or dropdown. */
export const chartQuestion = (body: FormBody): FormQuestion | undefined => body.questions.find((q) => q.type === "choice" || q.type === "dropdown");

export const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** A new question's id, as the host makes them. */
export const newId = (): string => Math.random().toString(36).slice(2, 10);
