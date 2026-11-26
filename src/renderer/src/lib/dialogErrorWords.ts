import { nameInLine } from "./hostWords";

/**
 * A dialog's red line, in words a person reads (docs/DESIGN.md "Typography":
 * a host's error is worded once, never its raw text). The forms a host or a
 * tool answers that were never written for a person each get a sentence: the
 * link down or silent, a key the host refuses ("forbidden: turnpass.set needs
 * admin"), git's stderr (its "error: " prefix, the tab-indented file list and
 * "Aborting" dropped, its first sentence kept). A refusal already in words
 * passes with "refused: " dropped and a plain first word raised; it keeps
 * its own ending (a one-line label has no period). `host` is the
 * computer asked, by its name ("The box"), set mid-line by `nameInLine`.
 */
export function dialogErrorWords(err: unknown, host?: string): string {
  const raw = (err instanceof Error ? err.message : String(err ?? "")).trim();
  if (!raw) return "";
  const named = host ? nameInLine(host) : "its host";
  const Named = named.charAt(0).toUpperCase() + named.slice(1);
  if (/^not connected\.?$|socket closed|connection closed|^closed\.?$|link .*down|linkDown/i.test(raw)) {
    return `${Named} is not connected. Try again once it is back.`;
  }
  if (/^no answer in \d+ ?s\b|\btimed out\b|^timeout\b/i.test(raw)) return `${Named} did not answer. Try again.`;
  if (/^forbidden: \S+ (needs \w+|is local-only|waits for Allow)/i.test(raw)) {
    return `This computer's key may not do that on ${named}.`;
  }
  const git = /^(?:error|fatal): ([^\n]+)/m.exec(raw);
  const line = (git ? git[1] : raw.replace(/^refused:\s*/i, "").split("\n")[0]).trim().replace(/:$/, "");
  // A plain first word is raised; a file's or a program's name ("index.lock", "simctl: …") keeps its case.
  return /^[a-z]+\b(?![.\/_-]\w|:)/.test(line) ? `${line.charAt(0).toUpperCase()}${line.slice(1)}` : line;
}
