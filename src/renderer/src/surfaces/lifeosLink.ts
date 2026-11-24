/**
 * A mail or a person named in an answer as a link to its LifeOS row (`[subject](#lifeos:mailThreads:<id>)`,
 * `[name](#lifeos:people:<id>)`, docs/agents/work-mail.md "The chat beside the mail"): drawn as an inline chip that
 * opens it. Any other `#lifeos:` table stays a plain link.
 */
export type LifeosLink = { table: "mailThreads" | "people"; id: string };

export function lifeosLinkOf(href: string | undefined): LifeosLink | null {
  const hit = href ? /^#lifeos:(mailThreads|people):([A-Za-z0-9_-]{1,64})$/.exec(href) : null;
  return hit ? { table: hit[1] as LifeosLink["table"], id: hit[2]! } : null;
}
