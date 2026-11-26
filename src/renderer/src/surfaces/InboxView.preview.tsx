// bun run ui:preview src/renderer/src/surfaces/InboxView.preview.tsx#InboxPreview
// InboxPreview draws the real list and selected detail. Fetch, resize and item actions need interaction.
import { useEffect, useState } from "react";
import type { GithubInboxItem, GithubInboxSnapshot } from "@server/shared/contract-github";
import { addPreviewHost, previewCwd, previewNoop, previewNow, previewProject, previewWorkspace } from "../lib/previewHost.preview";
import { inboxStore } from "../lib/inboxStore";
import { registry } from "../lib/connection";
import { workspaceStore } from "../lib/tcserver/workspaces";
import { InboxView } from "./InboxView";

type State = "loading" | "empty" | "populated";
const repos = ["field-notes/app", "studio/tools"];
const items = ["Keep the previous page on refresh", "Add a shortcut for new notes"];
const never = new Promise<never>(() => {});

async function attachHost(index: number, state: State) {
  const id = index === 0 ? "local" : "studio";
  const cwd = index === 0 ? previewCwd : "/projects/studio-tools";
  const workspace = { ...previewWorkspace, id: index === 0 ? previewWorkspace.id : "studio-tools", path: cwd, linkId: null, githubRepo: repos[index] };
  const item: GithubInboxItem = {
    kind: "issue", repo: repos[index], number: 24 + index, title: items[index], url: "https://example.invalid/issues/" + (24 + index),
    state: "open", draft: false, updatedAt: new Date(previewNow).toISOString(), author: null,
    assignees: [], labels: [], reviewDecision: "", headRefName: "", baseRefName: "", checks: null, reviewRequested: [],
  };
  const snapshot: GithubInboxSnapshot = {
    viewer: null, auth: { state: "ok", message: "" }, fetchedAt: previewNow, refreshing: false,
    repos: [{ repo: item.repo, fetchedAt: previewNow, error: null, items: state === "empty" ? [] : [item] }],
  };
  const host = await addPreviewHost({ id, name: index === 0 ? "This computer" : "Studio", answers: {
    "workspace.list": () => [workspace],
    "project.list": () => [{ ...previewProject, id: workspace.id + "-main", workspaceId: workspace.id, cwd }],
    "github.inbox": () => state === "loading" ? never : snapshot,
    "github.inboxRefresh": () => state === "loading" ? never : snapshot,
    "github.details": () => ({ body: "Keep the list visible until the next page arrives. Cover the offline case.", author: "alex" }),
    "github.thread": () => ({ comments: [] }),
  } });
  workspaceStore.attach(host);
  inboxStore.attach(host);
  await workspaceStore.refresh(host);
}

export function InboxPreview({ state = "populated" }: { state?: State }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let live = true;
    void attachHost(0, state).then(() => attachHost(1, state)).then(() => { if (live) setReady(true); });
    return () => {
      live = false;
      inboxStore.reset();
      workspaceStore.reset();
      registry.reset();
    };
  }, [state]);
  return <div className="flex h-[480px]">{ready ? <InboxView cwd="~" onClose={previewNoop} onStart={previewNoop} /> : null}</div>;
}
