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
  return app.slice(start, app.indexOf("\n  );\n", start));
};

describe("a thread or a draft he opens takes the pane", () => {
  it("the history opener clears the Work view once its open still holds, and claims his choice at the press", () => {
    const opener = body("onSelectHistorySession");
    expect(opener).toMatch(/const mine = choose\(\)/);
    expect(opener.indexOf("openWorkView(null)")).toBeGreaterThan(opener.indexOf('stillChosen(mine, null, "")'));
  });

  it("New thread and a project's New chat clear the Work view and claim his choice", () => {
    for (const name of ["onNew", "onNewChat"]) {
      const handler = body(name);
      expect(handler, name).toMatch(/choose\(\);\s*openWorkView\(null\);/);
    }
  });
});
