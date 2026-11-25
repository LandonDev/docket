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
  // To the hook's own dependency list: never into the next handler.
  return app.slice(start, app.indexOf("\n  }, [", start));
};

describe("a thread or a draft he opens takes the pane", () => {
  it("the history opener clears the Work view once its open still holds, and claims his choice at the press", () => {
    const opener = body("onSelectHistorySession");
    expect(opener).toMatch(/const mine = o\.behind \? null : choose\(\)/);
    expect(opener).toMatch(/if \(!o\.behind\) openWorkView\(null\)/);
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
