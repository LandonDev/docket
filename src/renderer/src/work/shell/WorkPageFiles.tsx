import { useState } from "react";
import { ChoiceSelect } from "../../components/choice-select";
import { LOCAL_ENVIRONMENT_ID, registry, useEnvironments } from "../../lib/connection";
import { thisDesktopInLine } from "../../lib/native";
import { isWebMode } from "../../lib/nativeWeb";
import { computerInLine, useComputerNames } from "../../lib/settings/computerName";
import { settingTitle } from "../../lib/settings/map";
import { useWorkHosts } from "../../lib/workSwitch";
import { SettingRow, SettingSection } from "../../surfaces/settings/parts/SettingRow";
import { setWordDefault, WORD_DEFAULTS, wordDefault, type WordDefault } from "../files/wordDefault";
import { GuestLinksRow } from "../guests/GuestLinksSection";
import { TeamsFilesRow } from "../office/TeamsFilesRow";
import { isDesktop } from "./actions";

/**
 * Settings → Files (docs/agents/settings.md "The pages: Work"): the folders Files lists, a section a desktop computer
 * with Work on ("Folders on <computer>") and one for the Windows VM a computer keeps ("Folders in the Windows VM");
 * each written by that computer's own window alone, the others' rows words with where they are changed. Then the
 * links shared with guests, in a sheet; then this Mac's own default for saving a Teams Word file.
 */
export function FilesPage({ guestsOpen = false }: { /** The guest links' sheet open from the first paint: the preview's seam. */ guestsOpen?: boolean }) {
  const linked = useEnvironments();
  const on = useWorkHosts();
  const names = useComputerNames();
  const hosts = linked.filter((e) => on.has(e.id));
  const mac = thisDesktopInLine();
  const own = (id: string): boolean => id === LOCAL_ENVIRONMENT_ID || names(id).own;
  return (
    <>
      {hosts
        .filter((h) => isDesktop(h.platform) || own(h.id))
        .map((h, i) => (
          <TeamsFilesRow
            key={h.id}
            // What a row's switch means is said once a page, over its first list.
            explain={i === 0}
            link={registry.linkOf(h.id)}
            host={h.name}
            title={settingTitle("files.folders", { computer: computerInLine(names(h.id)) })}
            setting="files.folders"
            editable={own(h.id)}
            elsewhere={`Changed from ${computerInLine(names(h.id))}.`}
          />
        ))}
      {/* A computer that keeps no Windows VM draws no section for it. */}
      {hosts
        .filter((h) => !isDesktop(h.platform))
        .map((h, i) => (
          <TeamsFilesRow
            key={`vm:${h.id}`}
            explain={!hosts.some((d) => isDesktop(d.platform) || own(d.id)) && i === 0}
            link={registry.linkOf(h.id)}
            host={h.name}
            title={settingTitle("files.vm")}
            setting="files.vm"
            vm
            editable={own(h.id)}
            elsewhere={`Changed from ${computerInLine(names(h.id))}.`}
          />
        ))}
      <SettingSection of="files.guests">
        <GuestLinksRow hosts={hosts.map((h) => h.id)} open={guestsOpen} />
      </SettingSection>
      {isWebMode() ? null : (
        <SettingSection of="files.word" vars={{ mac }}>
          <WordFilesRow />
        </SettingSection>
      )}
    </>
  );
}

/** How a Teams Word file saves before he chose for it (work/files/wordDefault.ts): kept in this window, a file he chose for keeps its choice. */
function WordFilesRow() {
  const [value, setValue] = useState<WordDefault>(wordDefault);
  return (
    <SettingRow id="files.word">
      <ChoiceSelect
        size="sm"
        label={settingTitle("files.word")}
        value={value}
        options={WORD_DEFAULTS}
        onChange={(next) => {
          setWordDefault(next);
          setValue(next);
        }}
      />
    </SettingRow>
  );
}
