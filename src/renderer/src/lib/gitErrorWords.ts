/**
 * A git step's failure as the Changes section says it (docs/DESIGN.md "Typography and text hierarchy": a path, a
 * port or a program's raw line is never on screen; a host's error is worded once). Git's own lines name lock files,
 * remotes and refs; each known form has its sentence here. A line that is plain already (our own, with no path,
 * colon, method name or code) passes as it is; anything else reads as the one general line.
 */
const RULES: [RegExp, string][] = [
  [/index\.lock|unable to create .*\.lock|another git process seems to be running/i, "Git is busy in this checkout. Try again."],
  [/\bCONFLICT\b|merge conflict|needs merge|unmerged (files|paths)|you have unmerged|fix conflicts/i, "Git stopped on a conflict. Resolve it in the files first."],
  [/would be overwritten by (merge|checkout)|commit your changes or stash them/i, "Your changes would be overwritten. Commit or stash them first."],
  [/authentication failed|could not read username|permission denied \(publickey\)|returned error: 403|terminal prompts disabled|gh auth login/i, "Git couldn't sign in to the remote."],
  [/has no upstream branch|no tracking information|no upstream configured/i, "This branch isn't published yet."],
  [/\[rejected\]|non-fast-forward|fetch first|updates were rejected/i, "The remote has commits this branch doesn't. Sync first."],
  [/could not resolve host|unable to access|could not read from remote|connection (refused|timed out)|network is unreachable/i, "Couldn't reach the remote."],
  [/nothing to commit|no changes added to commit/i, "Nothing to commit."],
  [/^not connected\.?$|connection closed|socket closed|^closed\.?$|did not answer|timed out/i, "The computer with this checkout isn't answering. Try again once it's back."],
];

/** One plain line for a raw git failure. */
export function gitErrorWords(raw: string): string {
  const text = raw.trim();
  for (const [pattern, words] of RULES) if (pattern.test(text)) return words;
  const plain = text.length > 0 && text.length <= 120 && !/[/\\:()]|\w\.\w|\b\d{2,5}\b|\n/.test(text);
  return plain ? text : "Git couldn't finish that. Try again.";
}
