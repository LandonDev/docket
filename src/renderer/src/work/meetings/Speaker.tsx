import { useState } from "react";
import type { MeetingSpeaker } from "@shared/contract-work-meetings";
import { BusyLabel, Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../../components/ui/popover";
import { sayError } from "../canvas/frame";
import { forgetVoice, listVoices, nameSpeaker } from "./data";

/**
 * A speaker's name at a turn's head, and the one place to change it: a click
 * opens a field, the name a kept voice offers ("Sounds like Dana Lee", Use)
 * and, once a voice is kept under the name, Forget this voice. A voice only
 * ever offers a name; nothing here is applied without his press.
 */
export function SpeakerName({ env, itemId, speaker }: { env: string; itemId: string; speaker: MeetingSpeaker | null }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<"save" | "use" | "forget" | null>(null);
  const [kept, setKept] = useState(false);
  if (!speaker) return <span className="min-w-0 truncate font-medium">Unknown</span>;
  const shown = speaker.name ?? speaker.label;
  const run = (what: "save" | "use" | "forget", work: () => Promise<void>, failed: string): void => {
    setBusy(what);
    work()
      .then(() => setOpen(false))
      .catch((error: unknown) => sayError(error, failed))
      .finally(() => setBusy(null));
  };
  const save = (name: string | null): Promise<void> => nameSpeaker(env, itemId, speaker.id, name);
  return (
    <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) return;
          setDraft(speaker.name ?? "");
          setKept(false);
          if (speaker.name) {
            const name = speaker.name;
            listVoices(env).then(
              (voices) => setKept(voices.some((v) => v.name === name)),
              () => setKept(false),
            );
          }
        }}
      >
        <PopoverTrigger
          render={<Button variant="link" size="xs" onClick={(event) => event.stopPropagation()} className="h-auto min-w-0 shrink p-0 text-[13px] leading-5 font-medium underline-offset-3" />}
        >
          <span className="truncate">{shown}</span>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 p-3" onClick={(event) => event.stopPropagation()}>
          <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const name = draft.trim();
              run("save", () => save(name || null), "Couldn't name the speaker");
            }}
          >
            <Input autoFocus aria-label={`Name for ${speaker.label}`} placeholder={speaker.label} value={draft} maxLength={120} onChange={(event) => setDraft(event.currentTarget.value)} />
            {speaker.suggested && !speaker.name ? (
              <div className="flex min-h-7 items-center gap-2 text-xs text-muted-foreground">
                <span className="min-w-0 flex-1 truncate">Sounds like {speaker.suggested}</span>
                <Button type="button" variant="ghost" size="xs" disabled={busy !== null} onClick={() => run("use", () => save(speaker.suggested!), "Couldn't name the speaker")}>
                  <BusyLabel busy={busy === "use"} label="Use" />
                </Button>
              </div>
            ) : null}
            <div className="flex items-center justify-end gap-1">
              {kept && speaker.name ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="me-auto text-muted-foreground hover:text-destructive"
                  disabled={busy !== null}
                  onClick={() => run("forget", () => forgetVoice(env, itemId, speaker.name!), "Couldn't forget the voice")}
                >
                  <BusyLabel busy={busy === "forget"} label="Forget this voice" />
                </Button>
              ) : null}
              <Button type="submit" variant="secondary" size="xs" disabled={busy !== null}>
                <BusyLabel busy={busy === "save"} label="Save" />
              </Button>
            </div>
          </form>
        </PopoverContent>
    </Popover>
  );
}
