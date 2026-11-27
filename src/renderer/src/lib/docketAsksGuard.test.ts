import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ClientRequest } from "@shared/contract";
import { capabilityRefusal, requiredCapability, type Capability } from "@shared/capabilities";
import { THREAD_MENU_METHODS, threadMenuRows } from "./threadMenu";
import { CORE_METHODS } from "./linkMayCore";
import { moveTargets } from "./threadMove";

/**
 * D5: on every Docket surface outside Work and Settings, a control that can only be refused is held while its host's
 * link is not open (disabled, the host's state its tooltip, or said by the line over the composer) and is not drawn,
 * or says who can, for a key that may not use it (`linkMay`, lib/linkMay.ts). The table below is every wire method
 * Docket's own controls send that needs more than `read`, each with the control that sends it, the file that gates
 * it, and the render that proves it for a key that may only read and for a link that is down. Work's own asks keep
 * their own guard (workAsksGuard.test.ts). A new control that sends one of these goes in the table with its renders.
 */

type Method = ClientRequest["method"];
/** A render that proves the control: the DOM test file (from src/renderer/src) and the exact title of its case. */
type Proof = readonly [file: string, title: string];
/** Not held while the link is down, and why: the press waits in the window, or the host away is said elsewhere. */
type NotHeld = { readonly notHeld: string };

type DocketAsk = {
  method: Method;
  /** What the host's table says the method needs; never `read`. */
  need: Exclude<Capability, "read">;
  control: string;
  /** The file whose code asks the key (and, for a held control, the link). */
  file: string;
  readKey: Proof;
  linkDown: Proof | NotHeld;
};

export const DOCKET_ASKS: readonly DocketAsk[] = [
  {
    method: "session.send",
    need: "operate",
    control: "the composer's Send",
    file: "chrome/Composer.tsx",
    readKey: ["chrome/Composer.asks.dom.test.tsx", "says who can on Send itself, so the reason stands when typed words hide the field's"],
    linkDown: ["surfaces/threadChat.blocked.dom.test.tsx", "says it once in a code thread: the line over the box, the field its own placeholder, send waits"],
  },
  {
    method: "session.permission",
    need: "approve",
    control: "the composer's permission select",
    file: "chrome/Composer.tsx",
    readKey: ["chrome/Composer.asks.dom.test.tsx", "drops the select on a thread for an operate-only key and offers a draft only the modes it may give"],
    linkDown: ["chrome/Composer.asks.dom.test.tsx", "is held on a thread, the link's words its tooltip, and live on a draft"],
  },
  {
    method: "session.compact",
    need: "operate",
    control: "the context meter's Compact",
    file: "chrome/composerAsks.ts",
    readKey: ["chrome/Composer.asks.dom.test.tsx", "offers no Compact and no Send to a read key"],
    linkDown: { notHeld: "Compact is offered only while the composer is not blocked (Composer.tsx `compactable`)" },
  },
  {
    method: "session.approve",
    need: "approve",
    control: "a waiting approval's Allow and Deny",
    file: "surfaces/transcript/ApprovalCard.tsx",
    readKey: ["surfaces/transcript/ApprovalCard.held.dom.test.tsx", "gives a key that may not approve who can, in the buttons' place"],
    linkDown: ["surfaces/transcript/ApprovalCard.held.dom.test.tsx", "holds Allow and Deny, the host's state on the pair"],
  },
  {
    method: "session.approve",
    need: "approve",
    control: "an approval toast's Allow and Deny",
    file: "chrome/ApprovalToasts.tsx",
    readKey: ["surfaces/transcript/ApprovalCard.held.dom.test.tsx", "gives a key that may not approve who can, in the buttons' place"],
    linkDown: ["chrome/ApprovalToasts.dom.test.tsx", "holds Allow and Deny while the host is away and gives them back when it returns"],
  },
  {
    method: "session.answer",
    need: "operate",
    control: "a waiting question's Skip and Continue",
    file: "surfaces/QuestionCard.tsx",
    readKey: ["surfaces/QuestionCard.dom.test.tsx", "says who can in place of Skip and Continue, with no key caps"],
    linkDown: ["surfaces/transcript/ApprovalCard.held.dom.test.tsx", "a question holds Skip and the last Continue, never Next"],
  },
  {
    method: "session.continue",
    need: "operate",
    control: "a failure card's Retry and model choices",
    file: "surfaces/FailureCard.tsx",
    readKey: ["lib/threadMenu.test.ts", "draws only this window's own rows for a read key"],
    linkDown: ["surfaces/transcript/ApprovalCard.held.dom.test.tsx", "a failure holds the actions that go to the host and keeps this computer's own"],
  },
  {
    method: "review.override",
    need: "approve",
    control: "a held review's Merge anyway",
    file: "surfaces/ReviewCard.tsx",
    readKey: ["surfaces/ReviewCard.dom.test.tsx", "is not offered to a key that may not approve"],
    linkDown: ["surfaces/ReviewCard.dom.test.tsx", "is held while the host is away"],
  },
  {
    method: "git.commitStaged",
    need: "operate",
    control: "Changes' Commit",
    file: "chrome/rail/ChangesPanel.tsx",
    readKey: ["chrome/rail/ChangesPanel.dom.test.tsx", "draws no control that writes for a key that may only read"],
    linkDown: ["chrome/rail/ChangesPanel.dom.test.tsx", "holds every git control while the host's link is not open"],
  },
  {
    method: "git.stageFile",
    need: "operate",
    control: "Changes' Stage, Unstage and Discard",
    file: "chrome/rail/ChangesPanel.tsx",
    readKey: ["chrome/rail/ChangesPanel.dom.test.tsx", "draws no control that writes for a key that may only read"],
    linkDown: ["chrome/rail/ChangesPanel.dom.test.tsx", "holds every git control while the host's link is not open"],
  },
  {
    method: "git.stash",
    need: "operate",
    control: "Changes' ⋯ menu (Pull, Push, Stash, Stage all)",
    file: "chrome/rail/ChangesPanel.tsx",
    readKey: ["chrome/rail/ChangesPanel.dom.test.tsx", "draws no control that writes for a key that may only read"],
    linkDown: ["chrome/rail/ChangesPanel.dom.test.tsx", "holds every git control while the host's link is not open"],
  },
  {
    method: "fs.createPath",
    need: "operate",
    control: "Files' New file, New folder, Rename and Delete",
    file: "chrome/FileTree.tsx",
    readKey: ["chrome/FileTree.dom.test.tsx", "offers a read key no New file, New folder, Rename or Delete"],
    linkDown: ["chrome/FileTree.dom.test.tsx", "holds New file, New folder, Rename, Delete and Paste while the host is away"],
  },
  {
    method: "session.notes.set",
    need: "operate",
    control: "Notes' Edit and Start the notes",
    file: "surfaces/threads/NotesPanel.tsx",
    readKey: ["surfaces/threads/NotesPanel.dom.test.tsx", "offers a read key no Edit"],
    linkDown: ["surfaces/threads/NotesPanel.dom.test.tsx", "holds Edit and Start the notes while the host is away"],
  },
  {
    method: "build.run",
    need: "operate",
    control: "Build's Build and Cancel",
    file: "chrome/rail/BuildPanel.tsx",
    readKey: ["chrome/rail/BuildPanel.dom.test.tsx", "offers a key that may not build no Build and no Cancel"],
    linkDown: ["chrome/rail/BuildPanel.dom.test.tsx", "holds Build and Cancel while the host is away"],
  },
  {
    method: "session.stopTask",
    need: "operate",
    control: "Activity's Stop",
    file: "surfaces/threads/ActivitySection.tsx",
    readKey: ["surfaces/threads/ActivitySection.mayStop.dom.test.tsx", "draws Stop for a key that may stop, and none for one that may not"],
    linkDown: ["surfaces/threads/ActivitySection.mayStop.dom.test.tsx", "holds Stop while the host is away"],
  },
  {
    method: "devServer.start",
    need: "operate",
    control: "the dev servers pane's Run",
    file: "surfaces/DevStarter.tsx",
    readKey: ["surfaces/DevStarter.dom.test.tsx", "draws no Run for a key that may only read, and holds it while the host is away"],
    linkDown: ["surfaces/DevStarter.dom.test.tsx", "draws no Run for a key that may only read, and holds it while the host is away"],
  },
  {
    method: "devServer.stop",
    need: "operate",
    control: "a live dev server's Stop (a ledger row's Stop sends resources.remove, gated the same way)",
    file: "chrome/DevServerRow.tsx",
    readKey: ["chrome/DevServerRow.dom.test.tsx", "draws no Stop for a key that may only read, and holds it while the host is away"],
    linkDown: ["chrome/DevServerRow.dom.test.tsx", "draws no Stop for a key that may only read, and holds it while the host is away"],
  },
  {
    method: "session.rename",
    need: "operate",
    control: "the thread menu's Rename (and every verb of it, THREAD_MENU_METHODS)",
    file: "chrome/useThreadMenu.tsx",
    readKey: ["lib/threadMenu.test.ts", "draws only this window's own rows for a read key"],
    linkDown: ["chrome/hostOffline.test.ts", "keeps pin, reveal and the order live and holds the host's verbs"],
  },
  {
    method: "session.archive",
    need: "operate",
    control: "the thread menu's Archive and the workspace menu's Archive",
    file: "chrome/ProjectRail.tsx",
    readKey: ["lib/threadMenu.test.ts", "draws only this window's own rows for a read key"],
    linkDown: ["chrome/hostOffline.test.ts", "keeps pin, reveal and the order live and holds the host's verbs"],
  },
  {
    method: "session.batch",
    need: "operate",
    control: "the Hosts menu's fleet switches",
    file: "chrome/HostRows.tsx",
    readKey: ["lib/threadMenu.test.ts", "draws only this window's own rows for a read key"],
    linkDown: ["chrome/HostRows.dom.test.tsx", "holds a host's submenu while the host is away, its state the reason, once the link's grace from the drop ends"],
  },
  {
    method: "session.pauseAllRunning",
    need: "operate",
    control: "the title bar's thread menu's Pause all",
    file: "chrome/ShellTitleBar.tsx",
    readKey: ["lib/threadStripModel.test.ts", "leaves out the running roots on a host whose key may not pause"],
    linkDown: { notHeld: "spans every host: its count and its press leave out a host whose key may not pause (lib/tcserver/commands.ts pauseAllWhereMay), a host away refuses and the press toasts" },
  },
  {
    method: "resources.remove",
    need: "operate",
    control: "Resources…' Remove",
    file: "chrome/ThreadResourcesDialog.tsx",
    readKey: ["lib/threadMenu.test.ts", "draws only this window's own rows for a read key"],
    linkDown: ["chrome/ThreadResourcesDialog.dom.test.tsx", "says the host did not answer when the read fails, and Retry asks again"],
  },
  {
    method: "session.pause",
    need: "operate",
    control: "a board row's Pause, Continue and Start now",
    file: "surfaces/threads/master/MasterRow.tsx",
    readKey: ["surfaces/threads/master/MasterRow.actions.dom.test.tsx", "keeps Message alone for a key that may only read"],
    linkDown: ["surfaces/threads/master/MasterRow.actions.dom.test.tsx", "keeps Message alone while its host is away, and dims the title by role, never the row by opacity"],
  },
  {
    method: "session.interrupt",
    need: "operate",
    control: "a fleet row's Stop",
    file: "surfaces/threads/fleet/AgentRow.tsx",
    readKey: ["surfaces/threads/fleet/AgentRow.dom.test.tsx", "draws no Stop for a key that may only read"],
    linkDown: { notHeld: "kept live: holding it would mean a link subscription under every fleet row (a hot path); the line over the composer says the host is away and a refused Stop toasts" },
  },
  {
    method: "session.interrupt",
    need: "operate",
    control: "the Stop above the composer",
    file: "surfaces/threads/WorkingStrip.tsx",
    readKey: ["surfaces/threads/WorkingStrip.dom.test.tsx", "draws no Stop, Continue, Resume or Start now for a key that may only read, and keeps the time"],
    linkDown: ["surfaces/threads/WorkingStrip.dom.test.tsx", "holds Stop and Continue while the host is away, the link's words their tooltip"],
  },
  {
    method: "session.resume",
    need: "operate",
    control: "Continue and Resume above the composer",
    file: "surfaces/threads/WorkingStrip.tsx",
    readKey: ["surfaces/threads/WorkingStrip.dom.test.tsx", "draws no Stop, Continue, Resume or Start now for a key that may only read, and keeps the time"],
    linkDown: ["surfaces/threads/WorkingStrip.dom.test.tsx", "holds Stop and Continue while the host is away, the link's words their tooltip"],
  },
  {
    method: "session.start",
    need: "operate",
    control: "Start now above the composer",
    file: "surfaces/threads/WorkingStrip.tsx",
    readKey: ["surfaces/threads/WorkingStrip.dom.test.tsx", "draws no Stop, Continue, Resume or Start now for a key that may only read, and keeps the time"],
    linkDown: ["surfaces/threads/WorkingStrip.dom.test.tsx", "holds Stop and Continue while the host is away, the link's words their tooltip"],
  },
  {
    method: "batch.setRules",
    need: "operate",
    control: "the batch foot's Edit…",
    file: "surfaces/threads/MasterView.tsx",
    readKey: ["surfaces/threads/master/BatchFoot.dom.test.tsx", "draws no Edit… and no Stop where the key may not use them"],
    linkDown: ["surfaces/threads/master/BatchFoot.dom.test.tsx", "holds Edit… and Stop while the master's host is away"],
  },
  {
    method: "batch.stopStep",
    need: "operate",
    control: "the batch foot's Stop",
    file: "surfaces/threads/MasterView.tsx",
    readKey: ["surfaces/threads/master/BatchFoot.dom.test.tsx", "draws no Edit… and no Stop where the key may not use them"],
    linkDown: ["surfaces/threads/master/BatchFoot.dom.test.tsx", "holds Edit… and Stop while the master's host is away"],
  },
  {
    method: "session.create",
    need: "operate",
    control: "a plan's Start build",
    file: "surfaces/threads/PlanView.tsx",
    readKey: ["surfaces/threads/PlanView.projectPlan.dom.test.tsx", "offers no Start build to a key that may not start a thread"],
    linkDown: ["surfaces/threads/PlanView.projectPlan.dom.test.tsx", "holds Start build while the plan's host is away"],
  },
  {
    method: "session.send",
    need: "operate",
    control: "a finished pass's Start pass",
    file: "surfaces/threads/ImplementationView.tsx",
    readKey: ["surfaces/threads/ImplementationView.dom.test.tsx", "offers no Start pass to a key that may not send"],
    // Not held: Start pass only arms this window's composer for the next pass; the message goes on Send, which the line holds.
    linkDown: { notHeld: "acts in this window alone: it arms the composer, whose Send the line over the box holds" },
  },
];

const RENDERER = resolve(import.meta.dirname, "..");
const read = (file: string): string => readFileSync(join(RENDERER, file), "utf8");
/** A file asks the key when it calls linkMay (the core's) or a hook built on it. */
const ASKS_KEY = /\b(useLinkMay|useLinksMay|linkMay|useComposerAsks|THREAD_MENU_METHODS)\b|\bmay: \(method\)/;
/** A file holds on the link when it reads it (or is handed the composer's `blocked`). */
const ASKS_LINK = /\b(useHostHeld|hostsHeld|HELD|useEnvironmentDegraded|blocked|host\?\.offline)\b|\bheld\b/;

function hasCase(file: string, title: string): boolean {
  const text = read(file);
  return text.includes(`it("${title}"`) || text.includes(`it('${title}'`) || text.includes(`it(\`${title}\``);
}

describe("Docket's asks", () => {
  it("lists only methods that need more than read, as the host's own table says", () => {
    const changes = DOCKET_ASKS.flatMap(({ method, need }) => {
      const actual = requiredCapability({ method });
      return actual === need ? [] : [`${method} needs ${actual}, table says ${need}`];
    });
    expect(changes).toEqual([]);
  });

  it("asks each method of the first-paint core (lib/linkMayCore.ts), never the full table's Work contract", () => {
    const missing = DOCKET_ASKS.filter(({ method }) => !(CORE_METHODS as readonly string[]).includes(method)).map(({ method, control }) => `${control}: ${method}`);
    expect(missing).toEqual([]);
    const heavy = [...new Set(DOCKET_ASKS.map(({ file }) => file))].filter((file) => /from "(\.\.\/)*(lib\/)?linkMay"|@shared\/capabilities"/.test(read(file)));
    expect(heavy).toEqual([]);
  });

  it("names a gate in the file of every control, and a link check where it is held", () => {
    const missing = DOCKET_ASKS.flatMap(({ control, file, linkDown }) => {
      if (!existsSync(join(RENDERER, file))) return [`${control}: ${file} is gone`];
      const text = read(file);
      return [
        ...(ASKS_KEY.test(text) ? [] : [`${control}: ${file} never asks the key (useLinkMay)`]),
        ...("notHeld" in linkDown || ASKS_LINK.test(text) ? [] : [`${control}: ${file} never reads the host's link`]),
      ];
    });
    expect(missing).toEqual([]);
  });

  it("proves each control for a key that may only read and for a link that is down", () => {
    const missing = DOCKET_ASKS.flatMap(({ control, readKey, linkDown }) =>
      [readKey, ...("notHeld" in linkDown ? [] : [linkDown])].flatMap(([file, title]) =>
        existsSync(join(RENDERER, file)) && hasCase(file, title) ? [] : [`${control}: no case "${title}" in ${file}`],
      ),
    );
    expect(missing).toEqual([]);
  });

  // The thread menu's Move to …: `session.move` goes to this machine's own server (`local`), which asks the other
  // host as admin, so the key it needs is the other host's admin key, not a row of the core table above.
  it("draws no Move to … for a key that is not admin on the other host, and holds it while that host's link is down", () => {
    const env = (id: string, name: string) => ({ id, name, routes: [], credentialRef: null });
    const envs = [env("local", "This Mac"), env("env_box", "box")];
    const hello = (caps: string[]) => ({ transport: "open" as const, lastHello: { environmentId: "x", contract: 1, caps: caps as never } });
    const thread = { id: "t", environmentId: "env_box", status: "idle" };
    expect(moveTargets(thread, envs, (id) => (id === "env_box" ? hello(["read"]) : hello(["admin"])), false)).toEqual([]);
    expect(moveTargets(thread, envs, (id) => (id === "env_box" ? { transport: "reconnecting" as const, lastHello: null } : hello(["admin"])), false)).toEqual([
      { environmentId: "local", name: "This Mac", ok: false, reason: "box is not connected" },
    ]);
    expect(requiredCapability({ method: "session.move" })).toBe("local");
  });

  it("draws none of the thread menu's host verbs for a key that may only read", () => {
    const readOnly = (method: Method) => capabilityRefusal(["read"], { method }) === null;
    const facts = { status: "running" as const, threadType: "chat" as const, projectId: "p", parentId: null, master: false, resources: 1, removable: 1, goal: false, moves: [] };
    const shown = threadMenuRows({ ...facts, may: readOnly }, { open: true, newPass: true }).flatMap((row) => (row.kind === "item" || row.kind === "sub" ? [row.id] : []));
    expect(shown.filter((id) => THREAD_MENU_METHODS[id])).toEqual([]);
    for (const method of Object.values(THREAD_MENU_METHODS)) expect(requiredCapability({ method }), method).not.toBe("read");
  });
});
