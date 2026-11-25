import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A thread or a new draft he opens takes the pane: a Work view over it (Tasks, Projects) leaves, whether the thread's
 * tab was open (activateTab clears the view) or closed (the history opener does), and each counts as his latest
 * choice (lib/workSwitch.ts `choose`). App.tsx has no unit harness of its own, so its source holds the rule.
 */
const app = readFileSync(join(__dirname, "..", "App.tsx"), "utf8");
const body = (name: string): string => {
  const start = app.indexOf(`const ${name} = useCallback(`);
  expect(start, name).toBeGreaterThan(-1);
  // To the next declaration at the component's level: one handler, never the next.
  return app.slice(start, app.indexOf("\n  const ", start + 1));
};

describe("a thread or a draft he opens takes the pane", () => {
  it("the history opener clears the Work view once its open still holds, and claims his choice at the press", () => {
    const opener = body("onSelectHistorySession");
    expect(opener).toMatch(/const mine = o\.behind \? null : choose\(\)/);
    expect(opener).toMatch(/if \(!o\.behind\) openWorkView\(null\)/);
    // A page over the threads (Today, the Outbox) leaves at his pick too.
    expect(opener).toMatch(/if \(!o\.behind\) shell\.closeOverlays\(\);/);
    expect(opener.indexOf("openWorkView(null)")).toBeGreaterThan(opener.indexOf('stillChosen(mine, null, "")'));
  });

  it("the neighbour the app picks after an archive or a delete fills the pane behind: no Work view leaves", () => {
    expect(app).toMatch(/onSelectHistorySession\(next\.id, undefined, \{ behind: true \}\)/);
    expect(app).toMatch(/onSelectHistorySession\(plan\.select, undefined, \{ behind: true \}\)/);
    // A neighbour with a tab of its own is switched to behind the view too: activateTab keeps the view for `behind`.
    expect(app).toMatch(/activateTab\(plan\.activeTabId, \{ behind: true \}\)/);
    expect(app).toMatch(/if \(!o\.behind\) openWorkView\(null\);\s*workspaceActions\.activateTab\(id\)/);
    expect(body("onSelectHistorySession").match(/focusOpenSession\(sessionId, o\)/g)).toHaveLength(2);
  });

  it("New thread and a project's New chat clear the Work view and claim his choice", () => {
    for (const name of ["onNew", "onNewChat"]) {
      const handler = body(name);
      expect(handler, name).toMatch(/choose\(\);\s*openWorkView\(null\);/);
    }
  });
});

describe("a pane a Work view or page covers", () => {
  const pane = readFileSync(join(__dirname, "..", "surfaces", "SessionPane.tsx"), "utf8");
  it("stays the appshot's and the panel's, but never tells the host he looks at it", () => {
    expect(pane).toMatch(/useShell\(\(s\) => anyViewOpen\(s\) \|\| s\.settingsOpen\)/);
    expect(pane).toMatch(/const covered = workView !== null \|\| viewOver;/);
    expect(pane).toMatch(/noteActiveSession\(session\.id\);\s*if \(!covered\) serverCommands\.focusSignal\.pane/);
    // The pane's visibility is the tab's alone: a covered pane keeps its transcript and scroll live.
    expect(app).toMatch(/visible=\{tab\.id === shownTabId\}/);
  });
});
