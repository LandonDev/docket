# Work: tasks

A linked Work workspace's Tasks view, and Done as the owner accepting a thread's work (milestone 25).

## The view

`src/renderer/src/work/tasks/TasksView.tsx`, registered by `tasks/view.ts` as a lazy chunk. It reads the sector's open tasks through work-kit's shared task client (`createLifeosViewsClients` in `work-kit/lifeos`, made in `tasks/client.ts`) on the workspace's LifeOS session, which is narrowed to its sector. The groups are LifeOS's own (`groupTasks` from `work-kit/lifeos/tasks`): the first of Today leads with Start thread, Done and Snooze; then Today, This week, Later and Waiting. A row's due time gives way to Start on hover; its menu leads with Start thread.

Start thread is `startThread(chip)` with `{kind: 'task', label, ref: {at: 'lifeos', table: 'tasks', id}}`: a new thread's composer with the chip in it, and nothing runs until he sends. The first send carries `about`, and the host links the thread to the task (`ctx.links.link`).

The renderer names only the pure work-kit modules (`work-kit/lifeos`, `work-kit/lifeos/tasks`, `work-kit/views/lib/*`); the client types come off the maker in `tasks/client.ts`. Naming `work-kit/views` anywhere in renderer source, a comment included, brings its Kobra components into `work-kit-sources.css`.

## `work.tasks.done {taskId}` (approve)

Done in the view goes through the host, not straight to LifeOS. `tasks/index.ts` reads the task's links (`workLinks:byEntity`) and its sector (`tasks:get`), and completes it with `tasks:complete {id, reason: 'Accepted the work of "<thread title>"', threadLink}` naming this host's newest linked thread of the task's own sector; with none, it completes it plainly. Answers `{threadId, nextId}`. A send that goes still completes the thread's linked tasks through `ctx.links.completeFor` (the hold's own path).
