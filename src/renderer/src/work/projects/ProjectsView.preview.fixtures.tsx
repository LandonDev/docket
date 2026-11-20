// Fixtures for `bun run ui:preview src/renderer/src/work/projects/ProjectsView.preview.tsx#ProjectsPreview --width 1160`.
export default [
  { name: "The list: a group a state, final states folded", props: { screen: "list", height: 420 } },
  { name: "The board: a lane a state", props: { screen: "board", height: 420 } },
  { name: "A project: head, tabs, tree, documents, activity beside", props: { screen: "project", height: 640 } },
  { name: "A project's task board", props: { screen: "projectBoard", height: 560 } },
  { name: "A task's peek on a wide pane: the work makes room", props: { screen: "peek", height: 640, width: 1400 } },
  { name: "A task's peek on a pane under 1280px: it lies over the work", props: { screen: "peek", height: 640, width: 1120 } },
  { name: "A task's own page", props: { screen: "task", height: 560 } },
  { name: "New project", props: { screen: "new", height: 300 } },
];
