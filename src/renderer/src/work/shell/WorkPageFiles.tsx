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
import { filesPageLine, TeamsFilesRow, type OpensIn } from "../office/TeamsFilesRow";
import { PageSection } from "../../components/page";
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
  // What each list says of itself, so the page says what they share once, under its title.
  const [says, setSays] = useState<Record<string, { any: boolean; common: OpensIn | null }>>({});
  // One stable report a list, kept for the page's life (state, not a ref: it is read while drawing).
  const [reporters] = useState(() => new Map<string, (said: { any: boolean; common: OpensIn | null } | null) => void>());
  const saysFor = (key: string) => {
    let report = reporters.get(key);
    if (!report) {
      report = (said) =>
        setSays((was) => {
          if (said === null) {
            if (!(key in was)) return was;
            const rest = { ...was };
            delete rest[key];
            return rest;
          }
          return was[key]?.any === said.any && was[key]?.common === said.common ? was : { ...was, [key]: said };
        });
      reporters.set(key, report);
    }
    return report;
  };
  const head = filesPageLine(Object.values(says));
  return (
    <>
      {/* Under the title, as a page's line sits: a section's 24px drawn back to the title line's 4px. */}
      {head ? (
        <PageSection data-files-line="" className="-mt-5" description={head.line}>
          {null}
        </PageSection>
      ) : null}
      {hosts
        .filter((h) => isDesktop(h.platform) || own(h.id))
        .map((h) => (
          <TeamsFilesRow
            key={h.id}
            pageSays={head?.opens}
            onSays={saysFor(h.id)}
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
        .map((h) => (
          <TeamsFilesRow
            key={`vm:${h.id}`}
            pageSays={head?.opens}
            onSays={saysFor(`vm:${h.id}`)}
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
