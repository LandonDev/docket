import { registry } from "../../lib/connection";

/**
 * The job's Microsoft forms a person answered (`work.msforms.byPerson`, docs/agents/work-msforms.md
 * "Around the rest of Work"): asked of the workspace's host by their addresses, one row a form, newest
 * answer first. A form not read since the host started is read first, so the answer may take a while.
 */

export interface AnsweredForm {
  formId: string;
  title: string;
  tenant: string;
  at: number | null;
}

type ByPerson = { email: string; forms: AnsweredForm[] }[];

/** One row a form across all their addresses, the newest answer kept, newest first. */
export function answeredForms(got: ByPerson): AnsweredForm[] {
  const by = new Map<string, AnsweredForm>();
  for (const e of got) for (const f of e.forms) if (!by.has(f.formId) || (f.at ?? 0) > (by.get(f.formId)!.at ?? 0)) by.set(f.formId, f);
  return [...by.values()].sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}

/** A host with no Microsoft forms, or one that cannot answer, lists none. */
export async function readAnswered(env: string, workspaceId: string, emails: readonly string[]): Promise<AnsweredForm[]> {
  if (!emails.length) return [];
  try {
    const got = await registry.linkOf(env).request<ByPerson>("work.msforms.byPerson", { workspaceId, emails: emails.slice(0, 50) }, { timeoutMs: 180_000 });
    return answeredForms(got);
  } catch {
    return [];
  }
}
