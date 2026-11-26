// bun run ui:preview src/renderer/src/chrome/menuRows.preview.tsx#ThreadMenus --shot --fresh
// Exports ThreadMenus and ReadOnlyThreadMenu. Static menus stay open without keyboard or pointer actions.
import { MenuSketch } from "./menuRows.fixtures";
import { threadMenuRows, type ThreadMenuFacts } from "../lib/threadMenu";

function rows(status: ThreadMenuFacts["status"], master = false) {
  return threadMenuRows({
    status, master, threadType: master ? "orchestration" : "implementation",
    projectId: "guide", parentId: null, resources: 2, removable: 2, goal: false, side: true, moves: [],
  });
}

export function ThreadMenus({ status = "running", master = false }: { status?: ThreadMenuFacts["status"]; master?: boolean }) {
  return <MenuSketch rows={rows(status, master)} />;
}

// The menu builder has no access input yet. This records the actions it offers today.
export function ReadOnlyThreadMenu() { return <MenuSketch rows={rows("idle")} />; }
