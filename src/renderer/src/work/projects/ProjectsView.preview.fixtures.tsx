// Fixtures for `bun run ui:preview src/renderer/src/work/projects/ProjectsView.preview.tsx#ProjectsPreview --width 1460`.
export default [
  { name: "The list: the tracker's rows for one job, by target date; paused and backlog folded; Show finished", props: { screen: "list", height: 360 } },
  { name: "The list with its Threads column, as M7 fills it", props: { screen: "list", height: 360, threads: true } },
  { name: "The list under 896px: two lines a row", props: { screen: "list", height: 420, width: 560, threads: true } },
  { name: "The list while it reads: bones in the rows' shape", props: { screen: "list", height: 280, loading: true } },
  { name: "The board: a lane a state, no lane fill", props: { screen: "board", height: 420 } },
  { name: "A project: one reading column (brief, plan, files, log)", props: { screen: "project", height: 1000 } },
  { name: "A project with its threads in the plan, files and log, as M7 fills them", props: { screen: "project", height: 1000, threads: true } },
  { name: "A project's task board", props: { screen: "projectBoard", height: 640 } },
  { name: "A task's peek on a wide pane: flat, the work makes room", props: { screen: "peek", height: 700, width: 1400 } },
  { name: "A task's own page", props: { screen: "task", height: 560 } },
  { name: "New project: a dialog over the list", props: { screen: "new", height: 420 } },
];
