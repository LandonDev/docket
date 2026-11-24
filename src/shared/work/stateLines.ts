export type StateFact = "answer" | "held === writes" | "live session" | "stored token" | "queued" | "read" | "local";

type Line = readonly [literal: string, fact: StateFact];
const R = "src/renderer/src/work";
const H = "src/main/server/work";

// Read by stateLinesGuard.test.ts. A repeated literal has one entry per use, in source order.
export const STATE_LINES: Readonly<Record<string, readonly Line[]>> = {
  [`${R}/agenda/added.ts`]: [
    ["`Sending invites: ${op.title}`", "queued"],
    ["`Invites sent: ${op.title}`", "answer"],
    ["`Added ${op.title}`", "answer"],
  ],
  [`${R}/canvas/KindBar.tsx`]: [
    ["Saved to Downloads", "answer"],
    ["`Saved ${name} to the workspace`", "answer"],
  ],
  [`${R}/clashes/model.ts`]: [
    ["`Moved ${title}`", "answer"],
  ],
  [`${R}/connections/model.ts`]: [
    ["Ready", "answer"],
  ],
  [`${R}/files/SaveAs.tsx`]: [
    ["`Saved a copy of ${got.saved.name} in ${folder.name}`", "answer"],
  ],
  [`${R}/files/acts.ts`]: [
    ["Moved", "answer"],
    ["Copied", "answer"],
    ["`Saved as Word in ${to.name}`", "answer"],
    ["Deleted", "answer"],
    ["`Added ${entry.name} to ${project.name}`", "answer"],
    ["Added 1 file from Drive", "answer"],
    ["`Added ${files.length} files from Drive`", "answer"],
  ],
  [`${R}/files/fileText.ts`]: [
    ["`Saved ${whenWords(line.at, now)}${place ? ` in ${place}` : \"\"}`", "answer"],
    ["`Saved in ${place}`", "answer"],
    ["Saved", "answer"],
    ["`Saved to ${host} ${whenWords(back.at, now)}`", "held === writes"],
    ["`Saved, uploading to ${service}…`", "answer"],
    ["`Saved to ${computer}. OneDrive uploads it`", "answer"],
  ],
  [`${R}/files/wordSave.ts`]: [
    ["`Saved to ${computer} ${whenWords(word.at, now)}`", "answer"],
    ["`Saved to ${computer} as Word ${whenWords(word.at, now)}`", "answer"],
    ["`Saved beside it as ${got.copy.name}`", "answer"],
  ],
  [`${R}/formats/PreviewFrame.tsx`]: [
    ["`Saved ${made.name} to ${made.where}`", "answer"],
  ],
  [`${R}/forms/FormCanvas.tsx`]: [
    ["Copied", "local"],
    ["Copied", "local"],
    ["Copied", "local"],
  ],
  [`${R}/google/UploadGoogleDialog.tsx`]: [
    ["`Saved to Google ${kind}`", "answer"],
  ],
  [`${R}/guests/GuestLinksSection.tsx`]: [
    ["Copied the new address", "local"],
  ],
  [`${R}/guests/Share.tsx`]: [
    ["Copied", "local"],
    ["Done", "local"],
    ["Done", "local"],
  ],
  [`${R}/history/HistoryCanvas.tsx`]: [
    ["Restored", "read"],
    ["Saved", "read"],
    ["`Restored the ${dayTime(from.at)} version`", "read"],
    ["Restored an older version", "read"],
    ["`Restored the ${dayTime(target.at)} version`", "answer"],
  ],
  [`${R}/mail/MailCanvas.tsx`]: [
    ["Sending", "queued"],
  ],
  [`${R}/mail/chat/AddRow.tsx`]: [
    ["Added", "read"],
  ],
  [`${R}/mail/sentState.ts`]: [
    ["Sent", "read"],
    ["`Scheduled for ${scheduleLine(row.sendAt, zone, row.sendZone, now)}`", "queued"],
    ["Sending", "queued"],
  ],
  [`${R}/messages/Composer.tsx`]: [
    ["Copied", "local"],
    ["Sending from the Outbox", "queued"],
  ],
  [`${R}/messages/Conversation.tsx`]: [
    ["Copied", "local"],
  ],
  [`${R}/messages/Message.tsx`]: [
    ["Sending", "queued"],
  ],
  [`${R}/messages/live.ts`]: [
    ["Saved to Downloads", "answer"],
  ],
  [`${R}/money/MoneyView.tsx`]: [
    ["Restored as a suggestion: accept it in the ledger", "answer"],
  ],
  [`${R}/office/AddinRow.tsx`]: [
    ["Connected", "live session"],
    ["Done", "local"],
  ],
  [`${R}/office/live/liveSwitch.ts`]: [
    ["Sending your changes first…", "queued"],
  ],
  [`${R}/outbox/AwayList.tsx`]: [
    ["Done", "local"],
  ],
  [`${R}/outbox/OutboxView.tsx`]: [
    ["Sent", "answer"],
    ["`Scheduled for ${scheduleLine(item.scheduledFor, ownZone(), item.scheduledZone)}`", "queued"],
    ["Nothing held", "read"],
    ["Sent", "local"],
    ["Sent", "local"],
    ["Sending", "queued"],
    ["Sent mail cannot be taken back", "read"],
  ],
  [`${R}/outbox/model.ts`]: [
    ["Queued in LifeOS", "queued"],
  ],
  [`${R}/pdf/PdfCanvas.tsx`]: [
    ["`Moved, as of ${dayTime(view.missing.asOf)}`", "read"],
  ],
  [`${R}/routines/model.ts`]: [
    ["Done", "read"],
  ],
  [`${R}/rules/HouseRules.tsx`]: [
    ["`Added to ${workspace.name}'s rules`", "answer"],
  ],
  [`${R}/rules/RuleLine.tsx`]: [
    ["Added to", "read"],
  ],
  [`${R}/sheets/SheetBody.tsx`]: [
    ["`Saved ${name} without ${left.join(\" and \")}`", "answer"],
    ["`Saved ${name}`", "answer"],
  ],
  [`${R}/sheets/imported.ts`]: [
    ["`Saved ${done.path ? nameOf(done.path) : imported.name}`", "answer"],
  ],
  [`${R}/shell/ProjectSettings.tsx`]: [
    ["Done", "local"],
  ],
  [`${R}/shell/settings.tsx`]: [
    ["Signed in", "live session"],
  ],
  [`${R}/tasks/NewTaskDialog.tsx`]: [
    ["`Added to ${jobNameNow(sector)}`", "answer"],
  ],
  [`${R}/tasks/TaskSheet.tsx`]: [
    ["Done", "local"],
  ],
  [`${R}/tasks/TasksView.tsx`]: [
    ["Done", "local"],
    ["Done", "read"],
  ],
  [`${R}/templates/SaveDialog.tsx`]: [
    ["Saved to Templates", "answer"],
  ],
  [`${R}/templates/TemplatesView.tsx`]: [
    ["Moved to Trash", "answer"],
  ],
  [`${R}/today/TodayView.tsx`]: [
    ["All clear", "read"],
  ],
  [`${R}/today/held.ts`]: [
    ["Sending", "queued"],
  ],
  [`${R}/winvm/WinvmSection.tsx`]: [
    ["`Signed in as ${place.account ?? \"you\"}${place.state === \"no-libraries\" ? \", no Teams library synced yet\" : count}`", "read"],
  ],
  [`${H}/agenda/index.ts`]: [
    ["Added ", "answer"],
  ],
  [`${H}/browser/health.ts`]: [
    ["`Signed in as ${who}`", "stored token"],
    ["Signed in", "stored token"],
  ],
  [`${H}/digest/rule.ts`]: [
    ["Sent mail with no answer", "read"],
  ],
  [`${H}/files/tools.ts`]: [
    ["Moved", "answer"],
    ["Copied", "answer"],
    ["Deleted", "answer"],
    ["Moved", "answer"],
    ["Copied", "answer"],
    ["Moved back", "answer"],
    ["Moved back", "answer"],
  ],
  [`${H}/frameio/auth.ts`]: [
    ["Signed in to Frame.io. You can close this tab.", "answer"],
  ],
  [`${H}/frameio/health.ts`]: [
    ["`Signed in as ${who}`", "stored token"],
    ["Signed in", "stored token"],
  ],
  [`${H}/frameio/post.ts`]: [
    ["`Added ${p.name} to ${p.ontoName} in Frame.io`", "answer"],
  ],
  [`${H}/frameio/tools.ts`]: [
    ["`Sent: ${summary}.`", "answer"],
    ["Added a comment", "answer"],
  ],
  [`${H}/google/uploads.ts`]: [
    ["`Saved ${title} to Google ${app}`", "answer"],
  ],
  [`${H}/lifeos/health.ts`]: [
    ["Signed in", "live session"],
    ["Syncing", "read"],
    ["Synced", "read"],
  ],
  [`${H}/media/tools.ts`]: [
    ["Added a note", "answer"],
    ["`Added: note ${notes[0].id} at v${v.n} ${momentOf(v, frame, table)}.`", "answer"],
    ["`Added ${notes.length} chapter${notes.length === 1 ? '' : 's'}`", "answer"],
    ["Added", "answer"],
    ["`Added v${v.n} ${v.name}.`", "answer"],
  ],
  [`${H}/messages/health.ts`]: [
    ["Synced", "read"],
  ],
  [`${H}/messages/held.ts`]: [
    ["`Sent to ${got.chat.name} in ${SOURCE_NAME[source]}`", "answer"],
  ],
  [`${H}/messages/tools.ts`]: [
    ["`Saved as a draft in the conversation. Nothing was sent: nothing here can send to ${SOURCE_NAME[source]}. Tell the owner the draft waits there for him to copy into ${SOURCE_NAME[source]}.`", "answer"],
  ],
  [`${H}/office/health.ts`]: [
    ["`Syncing ${count}${tenants.length ? ` for ${listOf(tenants)}` : ''}`", "read"],
    ["`Signed in as ${vm.onedrive.account}, ${libs}`", "read"],
    ["`Signed in as ${vm.onedrive.account}, its libraries are on their way`", "read"],
    ["`Signed in as ${vm.onedrive.account}, no Teams library synced`", "read"],
  ],
  [`${H}/office/held.ts`]: [
    ["Sent", "answer"],
  ],
  [`${H}/office/live/health.ts`]: [
    ["Signed in", "stored token"],
  ],
  [`${H}/outbox/lifeosHeld.ts`]: [
    ["Queued to send to", "queued"],
    ["`Queued in LifeOS: ${calendarWords(p).summary}`", "queued"],
  ],
  [`${H}/outbox/outbox.ts`]: [
    ["Queued to send", "queued"],
    ["Sent", "answer"],
  ],
  [`${H}/routines/engine.ts`]: [
    ["Nothing held", "read"],
  ],
  [`${H}/search/sources/lifeos.ts`]: [
    ["Done", "read"],
  ],
  [`${H}/sheets/host/host.ts`]: [
    ["Deleted rows", "answer"],
    ["Deleted columns", "answer"],
    ["Moved cells", "answer"],
  ],
  [`${H}/sheets/packages.ts`]: [
    ["Restored an earlier version", "answer"],
    ["`Deleted ${op.count === 1 ? 'a row' : `${op.count} rows`}${many}`", "answer"],
    ["`Deleted ${op.count === 1 ? 'a column' : `${op.count} columns`}${many}`", "answer"],
    ["`Moved cells${many}`", "answer"],
    ["`Moved ${op.count === 1 ? 'a row' : `${op.count} rows`}${many}`", "answer"],
    ["`Moved ${op.count === 1 ? 'a column' : `${op.count} columns`}${many}`", "answer"],
    ["`Added ${op.name}${many}`", "answer"],
  ],
  [`${H}/slides/view.ts`]: [
    ["Added", "read"],
    ["Moved or resized", "read"],
  ],
  [`${H}/templates/tools.ts`]: [
    ["`Saved ${saved.name} to Templates${saved.fields.length ? `. It asks for ${fieldList(saved.fields)}` : ''}.`", "answer"],
  ],
  [`${H}/winvm/files.ts`]: [
    ["`Copied ${name} from ${from} on the Windows VM into the workspace as ${relative(into.folder, dest) || free}.`", "answer"],
  ],
};
