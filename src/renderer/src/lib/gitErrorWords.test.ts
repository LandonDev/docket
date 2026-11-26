import { describe, expect, it } from "vitest";
import { gitErrorWords } from "./gitErrorWords";

describe("gitErrorWords", () => {
  it("words each known git failure without its path, remote or ref", () => {
    const cases: [string, string][] = [
      ["fatal: Unable to create '/Users/l/p/.git/index.lock': File exists.", "Git is busy in this checkout. Try again."],
      ["CONFLICT (content): Merge conflict in src/a.ts", "Git stopped on a conflict. Resolve it in the files first."],
      ["error: Your local changes to the following files would be overwritten by checkout:\n\tsrc/a.ts", "Your changes would be overwritten. Commit or stash them first."],
      ["fatal: Authentication failed for 'https://github.com/x/y.git/'", "Git couldn't sign in to the remote."],
      ["fatal: The current branch feature has no upstream branch.", "This branch isn't published yet."],
      [" ! [rejected]        main -> main (fetch first)", "The remote has commits this branch doesn't. Sync first."],
      ["fatal: unable to access 'https://github.com/x/y.git/': Could not resolve host: github.com", "Couldn't reach the remote."],
      ["nothing to commit, working tree clean", "Nothing to commit."],
      ["not connected", "The computer with this checkout isn't answering. Try again once it's back."],
    ];
    for (const [raw, words] of cases) expect(gitErrorWords(raw), raw).toBe(words);
  });

  it("keeps a line that is plain already, and words anything else as one general line", () => {
    expect(gitErrorWords("Couldn't prepare the pull request")).toBe("Couldn't prepare the pull request");
    expect(gitErrorWords("error: pathspec 'src/x.ts' did not match any file(s) known to git")).toBe("Git couldn't finish that. Try again.");
    expect(gitErrorWords("server router not bound (git.stage)")).toBe("Git couldn't finish that. Try again.");
    expect(gitErrorWords("")).toBe("Git couldn't finish that. Try again.");
  });
});
