import type { AwayKind } from "@server/shared/away";
import { TooltipProvider } from "../components/ui/tooltip";
import { AwayRowView } from "./AwayRow";
import { Settings } from "./icons";
import { RailRow } from "./RailRow";

/** The rail foot's last two rows at the rail's default width (200px), in a place of `place`'s kind, for
 *  `bun run ui:preview src/renderer/src/chrome/AwayRow.preview.tsx#AwayFootPreview`. */
export function AwayFootPreview({ code, work, place = "code", at = 0 }: { code: boolean; work: boolean; place?: AwayKind; at?: number }) {
  return (
    <TooltipProvider>
      <div className="flex w-[200px] flex-col border-t border-border bg-sidebar p-2">
        <AwayRowView kinds={{ code, work }} checked={place === "code" ? code : work} place={place} at={at} onToggle={() => {}} />
        <RailRow icon={Settings} label="Settings" />
      </div>
    </TooltipProvider>
  );
}
