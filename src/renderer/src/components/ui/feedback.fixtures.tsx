// bun run ui:preview src/renderer/src/components/ui/feedback.fixtures.tsx#FeedbackGallery --shot --fresh
// Export FeedbackGallery. Static shots hold progress and attachment state, without timed updates or animation.
import { FileText } from "@renderer/chrome/icons";
import { Region } from "../bones";
import { Alert, AlertDescription, AlertTitle } from "./alert";
import { Attachment, AttachmentContent, AttachmentDescription, AttachmentMedia, AttachmentTitle } from "./attachment";
import { Button } from "./button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "./empty";
import { Item, ItemContent, ItemMedia, ItemTitle } from "./item";
import { Kbd, KbdGroup } from "./kbd";
import { Progress, ProgressLabel, ProgressValue } from "./progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./table";

const alerts = [
  ["info", "Read-only access", "You can read files on this computer."],
  ["success", "Workspace saved", "The workspace is ready to use."],
  ["warning", "Host is going offline", "Save your changes before it disconnects."],
  ["error", "Couldn't list this project's files", "Try again to read this folder."],
] as const;

export function FeedbackGallery() {
  return (
    <div className="grid gap-5 md:grid-cols-2">
      <div className="flex flex-col gap-2">
        {alerts.map(([variant, title, description]) => (
          <Alert key={variant} variant={variant}><AlertTitle>{title}</AlertTitle><AlertDescription>{description}</AlertDescription></Alert>
        ))}
        <Empty>
          <EmptyHeader><EmptyTitle>No files match</EmptyTitle><EmptyDescription>Clear the search to see all files.</EmptyDescription></EmptyHeader>
          <EmptyContent><Button variant="secondary" size="sm">Clear search</Button></EmptyContent>
        </Empty>
        <div className="grid grid-cols-2 gap-2">
          {(["bg-background", "bg-card", "bg-sidebar", "bg-popover"] as const).map((surface) => (
            <div key={surface} className={`p-3 ${surface}`}>
              <Region loading hold={0} label="Loading" bones={<div className="flex flex-col gap-1"><p className="text-[13px] leading-5">Release notes</p><p className="text-xs leading-4">Two days ago</p></div>} />
            </div>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-3">
        {(["foreground", "muted", "warning"] as const).map((fill, index) => (
          <Progress key={fill} fill={fill} value={[32, 64, 91][index]}><ProgressLabel>Disk use</ProgressLabel><ProgressValue /></Progress>
        ))}
        <KbdGroup>{(["sm", "md", "lg"] as const).map((size) => <Kbd key={size} size={size}>Enter</Kbd>)}</KbdGroup>
        <Table>
          <TableHeader><TableRow><TableHead>File</TableHead><TableHead>Size</TableHead></TableRow></TableHeader>
          <TableBody><TableRow><TableCell>guide.md</TableCell><TableCell>8 KB</TableCell></TableRow></TableBody>
        </Table>
        {(["default", "outline", "muted"] as const).map((variant) => (
          <Item key={variant} variant={variant}><ItemMedia variant="icon"><FileText /></ItemMedia><ItemContent><ItemTitle>Field guide</ItemTitle></ItemContent></Item>
        ))}
        {(["idle", "uploading", "processing", "error", "done"] as const).map((state, index) => (
          <Attachment key={state} state={state}>
            <AttachmentMedia><FileText /></AttachmentMedia>
            <AttachmentContent><AttachmentTitle>guide.md</AttachmentTitle><AttachmentDescription>{["Ready", "Uploading…", "Processing…", "Could not upload", "8 KB"][index]}</AttachmentDescription></AttachmentContent>
          </Attachment>
        ))}
      </div>
    </div>
  );
}
