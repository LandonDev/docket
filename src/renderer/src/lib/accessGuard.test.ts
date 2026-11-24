import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A new thread's access comes from one place on each side: the window's
 * `newThreadAccess`/`accessParams` (lib/session.ts) and the host's
 * `newThreadPermission` (src/shared/defaults.ts), both reading his Thread
 * defaults. This guard fails when a start path sets a mode by hand: a literal
 * mode, a fallback of its own, or a create that sends a mode he did not pick.
 * Its twin for the model: a create sends a provider, model or effort only as
 * his pick (commands.ts `modelParams`), and no Work path names one.
 */
const REPO = resolve(__dirname, "../../../..");
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "proof" || name === "fixtures" ? [] : sources(path);
    return /\.tsx?$/.test(name) && !/\.(test|dom\.test|preview|fixtures)\.tsx?$/.test(name) && !/\.d\.ts$/.test(name) ? [path] : [];
  });
}
const rel = (path: string) => relative(REPO, path);
const RENDERER = sources(join(REPO, "src/renderer/src"));
const HOST = sources(join(REPO, "src/main/server"));
const read = (path: string) => readFileSync(path, "utf8");

/** Metas the window draws for threads that exist elsewhere: shown, never created. */
const DISPLAY_ONLY = new Set([
  "src/renderer/src/surfaces/threads/master/useMasterModel.ts",
  "src/renderer/src/surfaces/threads/master/boardFixture.ts",
  "src/renderer/src/lib/appFacade.ts",
  "src/renderer/src/test/fakeMetaLink.ts",
  // The policy ↔ mode table: an unknown stored policy reads as the least access.
  "src/renderer/src/lib/tcserver/access.ts",
]);

describe("the new-thread access guard", () => {
  it("has no second default: DEFAULT_RUNTIME_MODE is gone", () => {
    const hits = [...RENDERER, ...HOST].filter((f) => read(f).includes("DEFAULT_RUNTIME_MODE")).map(rel);
    expect(hits).toEqual([]);
  });

  it("the window sets no mode by hand: no literal mode, no fallback of its own", () => {
    const hits: string[] = [];
    for (const file of RENDERER) {
      if (DISPLAY_ONLY.has(rel(file))) continue;
      read(file).split("\n").forEach((line, i) => {
        if (/runtimeMode\s*[:=]\s*["'](supervised|auto-accept-edits|auto|full-access)["']/.test(line)) hits.push(`${rel(file)}:${i + 1}`);
        if (/\?\?\s*["'](supervised|auto-accept-edits|full-access)["']/.test(line)) hits.push(`${rel(file)}:${i + 1}`);
        if (/\bpermission\s*:\s*["'](safe|edits|auto)["']/.test(line)) hits.push(`${rel(file)}:${i + 1}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it("the window turns a mode into a policy only for his pick (accessParams) or a change to an existing thread", () => {
    const users = RENDERER.filter((f) => /\bpolicyForMode\(/.test(read(f))).map(rel).sort();
    expect(users).toEqual(["src/renderer/src/lib/session.ts", "src/renderer/src/lib/tcserver/access.ts", "src/renderer/src/lib/tcserver/commands.ts"]);
    const commands = read(join(REPO, "src/renderer/src/lib/tcserver/commands.ts"));
    expect(commands.match(/policyForMode\(/g)).toHaveLength(1);
    expect(commands).toMatch(/"session\.permission", \{ sessionId, permission: policyForMode\(mode\) \}/);
  });

  it("every window create of a draft carries his pick alone", () => {
    const commands = read(join(REPO, "src/renderer/src/lib/tcserver/commands.ts"));
    const create = commands.slice(commands.indexOf('link.request<WireSessionMeta>("session.create", {'));
    expect(create.slice(0, create.indexOf("});"))).toMatch(/\.\.\.accessParams\(session\)/);
  });

  it("every window create of a draft carries his model pick alone: no provider, model, effort or window of its own", () => {
    const commands = read(join(REPO, "src/renderer/src/lib/tcserver/commands.ts"));
    const create = commands.slice(commands.indexOf('link.request<WireSessionMeta>("session.create", {'));
    const body = create.slice(0, create.indexOf("});"));
    expect(body).toMatch(/\.\.\.modelParams\(session\)/);
    expect(body).not.toMatch(/^\s*(provider|model|reasoning|context1m)\s*:/m);
  });

  it("no Work path starts a thread on a provider, model or effort it names: only his pick or the host's default", () => {
    // A Work module, view or dock, and Work's rows in lib (named as entryGraph.test.ts names them), never a preview.
    const work = RENDERER.filter((f) => {
      const r = rel(f);
      return (r.startsWith("src/renderer/src/work/") && !r.includes("/preview/")) || /^src\/renderer\/src\/lib\/work(?!space|ing|tree)[^/]*$/i.test(r);
    });
    /** Each with its reason: a rule of the product, never a fallback. */
    const allowed = new Map([
      // A mail chat cannot run on Muse (the driver refuses a narrowed thread there), so its draft moves to Claude, as a pick.
      ["src/renderer/src/work/mail/chat/MailDock.tsx", /^const claude = newSession\(draft\.environmentId, "claude", draft\.cwd, undefined, undefined, /],
    ]);
    const hits: string[] = [];
    for (const file of work) {
      read(file).split("\n").forEach((line, i) => {
        const literal = /\b(model|provider|reasoning|harness)\s*:\s*["'`]/.test(line) || /\bnewSession\([^,]+,\s*["']/.test(line);
        if (literal && !allowed.get(rel(file))?.test(line.trim())) hits.push(`${rel(file)}:${i + 1}`);
      });
    }
    expect(hits).toEqual([]);
    expect(work.length).toBeGreaterThan(100);
  });

  it("the host's starts ask for no mode but a starter's grant or a pick passed through", () => {
    const call = /\b(?:registry|reg)\.(?:startWith|create)\(/g;
    const allowed = [
      /^permission: (parentNow|callerNow|caller|live)\.permission$/, // an agent's child: never more than its starter
      /^\.\.\.\((opts|input)\.permission \? \{ permission: (opts|input)\.permission \} : \{\}\)$/, // his pick, passed through
      /^\.\.\.\(how === 'auto' \? \{ ceiling: plan\.permission \} : opts\.ceiling \? \{ ceiling: lowerPermission\(opts\.ceiling, plan\.permission\) \} : \{\}\)$/, // a ceiling only lowers
    ];
    const hits: string[] = [];
    let seen = 0;
    for (const file of HOST) {
      const text = read(file);
      for (const m of text.matchAll(call)) {
        let depth = 0;
        let end = m.index! + m[0].length - 1;
        for (; end < text.length; end++) {
          if (text[end] === "(") depth++;
          else if (text[end] === ")" && --depth === 0) break;
        }
        const args = text.slice(m.index!, end);
        for (const line of args.split("\n").map((l) => l.trim().replace(/,$/, ""))) {
          if (!/\bpermission\b/.test(line)) continue;
          seen++;
          if (!allowed.some((re) => re.test(line))) hits.push(`${rel(file)}: ${line}`);
        }
      }
    }
    expect(hits).toEqual([]);
    // The scan reaches them: orchestration, app_start_thread, the merge reviewer, four across hosts, a plan's build, the remote start.
    expect(seen).toBeGreaterThanOrEqual(9);
  });

  it("the host resolves a new thread's access in one place", () => {
    const hits = HOST.filter((f) => /\?\?\s*(d|plan|defaults)\.permission\b/.test(read(f))).map(rel);
    expect(hits).toEqual([]);
    expect(read(join(REPO, "src/main/server/sessions.ts"))).toMatch(/permission: newThreadPermission\(\{ asked: params\.permission, defaults: d, ceiling: internal\.ceiling \}\)/);
  });
});
