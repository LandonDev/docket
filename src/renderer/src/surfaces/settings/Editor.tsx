import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ReadFailure } from "./parts/ReadFailure";
import { NO_ANSWER } from "../../lib/connection/openRead";
import { EDITOR_IDS, EDITOR_LABELS, type EditorChoice, type EditorConfig } from "@shared/editor";
import type { LspStatusRow } from "@shared/domain";
import { DialogFooter, ErrorLine } from "../../chrome/ConfirmDialog";
import { ModalBody, ModalPanel } from "../../chrome/Modal";
import { ChoiceSelect } from "../../components/choice-select";
import { PageRowsSkeleton } from "../../components/page";
import { SettingSwitch } from "../../components/setting-switch";
import { BusyLabel, Button } from "../../components/ui/button";
import { CONSOLE } from "../../components/ui/console";
import { Dialog } from "../../components/ui/dialog";
import { Skeleton } from "../../components/ui/skeleton";
import { cn } from "../../lib/cn";
import { registry } from "../../lib/connection";
import { useHostRead } from "../../lib/connection/hostRead";
import { chooseEditorSetting, loadEditorConfig, useEditorConfig } from "../../lib/editorConfig";
import { isWebMode } from "../../lib/nativeWeb";
import { keyCaps } from "../../lib/keys";
import { retryBlockedEnsures } from "../../lib/monaco/lspGate";
import { computerInLine, useComputerName } from "../../lib/settings/computerName";
import { loadAutoSave, loadFormatOnSave, loadGhostText, saveAutoSave, saveFormatOnSave, saveGhostText, type FormatOnSave } from "../../lib/settings";
import { useProjects } from "../../lib/tcserver/workspaces";
import { LoadingLine } from "../SurfaceSkeleton";
import { Keys } from "./keys";
import { namesInLine } from "./PickerSettings";
import { SettingRow, SettingSection } from "./parts/SettingRow";
import { useSaved } from "./parts/useSaved";

type IdeaEngine = { dist: boolean; accepted: boolean; build: string };

type JavaDoctor = {
  found: boolean;
  path?: string;
  version?: string;
  jdtls: boolean;
  ideaServer?: IdeaEngine;
  error?: string;
};

function fmtBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

/** What one kind of language server is doing on this computer, for the end of its row's line: the projects it runs
 *  for and the memory it holds ("running for Alpha and Beta, 1.4 GB"), or "starting"; its failure is the row's red
 *  line. Nothing while none runs. */
export function serverWords(rows: readonly LspStatusRow[], names: ReadonlyMap<string, string>): { line: string | null; error: string | null } {
  const running = rows.filter((row) => row.state === "running");
  const failed = rows.find((row) => row.state === "error");
  const error = failed ? (failed.error ?? "Failed") : null;
  if (running.length) {
    // A project is named by its name alone: one this window cannot name is left out, never shown as its id.
    const projects = [...new Set(running.flatMap((row) => names.get(row.projectId) ?? []))];
    const memory = running.reduce((sum, row) => sum + (row.memoryBytes ?? 0), 0);
    const what = projects.length ? `running for ${namesInLine(projects)}` : "running";
    return { line: [what, ...(memory ? [fmtBytes(memory)] : [])].join(", "), error };
  }
  if (rows.some((row) => row.state !== "error")) return { line: "starting", error };
  return { line: null, error };
}

/** This computer's language servers, read every 5 s once the first answer is in, so the Java rows' lines stay
 *  current. A failed read adds nothing to those lines and keeps the last answer. */
function useLanguageServers(): LspStatusRow[] | undefined {
  const link = registry.primary();
  const read = useHostRead(link, () => link.request<LspStatusRow[]>("lsp.status"));
  const loaded = read.value !== undefined;
  const { retry } = read;
  useEffect(() => {
    if (!loaded) return;
    const timer = window.setInterval(retry, 5_000);
    return () => window.clearInterval(timer);
  }, [loaded, retry]);
  return read.value;
}

/** Which editor "Open in…" and "Open on the Mac" hand a file to. Auto takes the first of IDEA, VS Code and Xcode
 *  installed; a Swift file under ios/ goes to Xcode when Xcode is chosen or IDEA is absent. Absent at /ui and on a
 *  headless computer, where no editor runs. */
function OpenFilesIn() {
  const live = useEditorConfig();
  // This window's own answer: undefined while main is asked, null when it could not say.
  const [asked, setAsked] = useState<EditorConfig | null | undefined>(live ?? undefined);
  const saved = useSaved();
  const [chosen, setChosen] = useState<EditorChoice | null>(null);
  const web = isWebMode();
  const ask = useCallback(() => {
    setAsked(undefined);
    // A bridge that throws at the call is a failed read too.
    void Promise.resolve()
      .then(loadEditorConfig)
      .then(setAsked, () => setAsked(null));
  }, []);
  // Asked once on open; a change he makes comes back through the store.
  const first = useRef(!web && !live);
  useEffect(() => {
    if (first.current) ask();
  }, [ask]);
  const config = live ?? asked;
  if (!config) {
    if (web) return null;
    return (
      <SettingSection of="editor.openIn">
        {config === undefined ? (
          <PageRowsSkeleton rows={[{ description: true, control: "select" }]} />
        ) : (
          <ReadFailure computer={registry.primary().environmentId} error={NO_ANSWER} retry={ask} />
        )}
      </SettingSection>
    );
  }
  const found = EDITOR_IDS.filter((id) => config.installed[id]).map((id) => EDITOR_LABELS[id]);
  const editor = chosen ?? config.editor;
  const description =
    found.length === 0
      ? "No editor found. Install IntelliJ IDEA, VS Code or Xcode."
      : editor === "auto" && config.effective
        ? `Auto opens ${EDITOR_LABELS[config.effective]}`
        : editor !== "auto" && !config.installed[editor]
          ? `${EDITOR_LABELS[editor]} is not installed; ${config.effective ? `${EDITOR_LABELS[config.effective]} opens instead` : "nothing opens"}`
          : undefined;
  const options: { value: EditorChoice; label: string }[] = [{ value: "auto", label: "Auto" }, ...EDITOR_IDS.map((id) => ({ value: id, label: EDITOR_LABELS[id] }))];
  return (
    <SettingSection of="editor.openIn">
      <SettingRow id="editor.openIn" saved={saved} description={description}>
        <ChoiceSelect
          label="Open files in"
          value={editor}
          options={options}
          onChange={(choice) => {
            setChosen(choice);
            void saved.run(() => chooseEditorSetting(choice)).then(() => setChosen(null));
          }}
        />
      </SettingRow>
    </SettingSection>
  );
}

/**
 * Settings › Editor: how files save, inline suggestions and the editor "Open in…" uses, all of this window's, then Java
 * on this computer: its JDK and the IntelliJ engine, each with what its language server is doing (the separate
 * list of language servers folded into these two rows).
 */
export function EditorPage() {
  const [autoSave, setAutoSave] = useState(loadAutoSave);
  const [formatOnSave, setFormatOnSave] = useState<FormatOnSave>(loadFormatOnSave);
  const [ghostText, setGhostText] = useState(loadGhostText);
  const onFormat = (patch: Partial<FormatOnSave>) => {
    const next = { ...formatOnSave, ...patch };
    saveFormatOnSave(next);
    setFormatOnSave(next);
  };
  return (
    <>
      <SettingSection of="editor.autoSave">
        <SettingRow
          id="editor.autoSave"
          description={
            <>
              Writes 800 ms after the last keystroke;
              <Keys keys={keyCaps("mod+S")} />
              writes at once.
            </>
          }
        >
          <SettingSwitch
            label="Save as I type"
            on={autoSave}
            onChange={(on) => {
              saveAutoSave(on);
              setAutoSave(on);
            }}
          />
        </SettingRow>
        <SettingRow id="editor.formatJava">
          <SettingSwitch label="Format Java and Kotlin on save" on={formatOnSave.java} onChange={(on) => onFormat({ java: on })} />
        </SettingRow>
        <SettingRow id="editor.formatWeb">
          <SettingSwitch label="Format TypeScript and JavaScript on save" on={formatOnSave.web} onChange={(on) => onFormat({ web: on })} />
        </SettingRow>
      </SettingSection>

      <SettingSection of="editor.inline">
        <SettingRow id="editor.inline" description="From Claude, on your sign-in">
          <SettingSwitch
            label="Inline suggestions"
            on={ghostText}
            onChange={(on) => {
              saveGhostText(on);
              setGhostText(on);
            }}
          />
        </SettingRow>
      </SettingSection>

      <OpenFilesIn />
      <JavaSection />
    </>
  );
}

/** Java on this window's computer: the JDK and the IntelliJ engine as its doctor reports them; until it answers,
 *  nothing is said about either, and a failure is the section's line with Retry. */
function JavaSection() {
  const link = registry.primary();
  const mac = computerInLine(useComputerName(link.environmentId));
  const doctor = useHostRead(link, () => link.request<{ java?: JavaDoctor }>("doctor.get"));
  const java: JavaDoctor | null | undefined = doctor.value ? (doctor.value.java ?? null) : undefined;
  const engine: IdeaEngine | null | undefined = doctor.value ? (doctor.value.java?.ideaServer ?? null) : undefined;
  const servers = useLanguageServers();
  const projects = useProjects();
  const names = useMemo(() => new Map(projects.map((project) => [project.id, project.name])), [projects]);
  const jdtls = serverWords(servers?.filter((row) => row.lang === "java") ?? [], names);
  const idea = serverWords(servers?.filter((row) => row.lang === "idea") ?? [], names);

  const [eula, setEula] = useState<{ build: string; text: string } | null>(null);
  const [gateOpen, setGateOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // The licence dialog's own failure (reading or accepting it), said inside the dialog: the row's note sits behind
  // the scrim.
  const [eulaError, setEulaError] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [checking, setChecking] = useState(false);

  const openGate = () => {
    setGateOpen(true);
    setEulaError(null);
    if (eula) return;
    // The first open downloads the engine to read its licence.
    void link
      .request<{ build: string; text: string }>("idea.eula")
      .then(setEula)
      .catch((error) => setEulaError(error instanceof Error ? error.message : String(error)));
  };

  const accept = () => {
    if (accepting) return;
    setAccepting(true);
    setEulaError(null);
    void link
      .request("idea.acceptEula")
      .then(() => {
        setGateOpen(false);
        retryBlockedEnsures();
        void doctor.retry();
      })
      .catch((error) => setEulaError(error instanceof Error ? error.message : String(error)))
      .finally(() => setAccepting(false));
  };

  const checkUpdate = () => {
    setNote(null);
    setChecking(true);
    void link
      .request<{ current: string; latest: string; updated: boolean }>("idea.checkUpdate")
      .then((r) => {
        setNote(r.updated ? `Updated to build ${r.latest}. Read the licence again to turn it on.` : "Up to date.");
        void doctor.retry();
      })
      .catch(() => setNote("The update check failed."))
      .finally(() => setChecking(false));
  };

  const jdkLine =
    java === undefined
      ? null
      : !java || !java.found
        ? (java?.error ?? "No JDK found. Install JDK 21 or newer for Java.")
        : java.error
          ? `${java.version} needs 21 or newer`
          : [java.version, java.jdtls ? "language support ready" : "language support downloads on first use", ...(jdtls.line ? [jdtls.line] : [])].join(", ");

  const engineLine =
    engine === undefined
      ? null
      : !engine || !engine.dist
        ? "Not downloaded"
        : engine.accepted
          ? [`Build ${engine.build}`, ...(idea.line ? [idea.line] : [])].join(", ")
          : `Build ${engine.build}, waiting for the licence`;

  const loading = <Skeleton className="mt-1 h-3 w-40" />;
  const failed = !doctor.value && doctor.error !== null;

  return (
    <SettingSection
      of="editor.jdk"
      vars={{ mac }}
    >
      {failed ? (
        <ReadFailure computer={registry.primary().environmentId} error={doctor.error ?? ""} retry={doctor.retry} />
      ) : (
        <>
          <SettingRow
            id="editor.jdk"
            description={jdkLine === null ? loading : <span className={java?.error || !java?.found ? "text-warning" : undefined}>{jdkLine}</span>}
            error={jdtls.error}
          />
          <SettingRow id="editor.intellij" description={note ?? engineLine ?? loading} error={idea.error}>
            {engine === undefined ? (
              // Which verb applies is the doctor's to say: its button's place until then.
              <Skeleton data-engine-action className="h-7 w-28 rounded-md" />
            ) : engine?.accepted ? (
              <Button variant="secondary" size="sm" disabled={checking} onClick={checkUpdate}>
                <BusyLabel busy={checking} label="Check for update" />
              </Button>
            ) : (
              <Button variant="secondary" size="sm" onClick={openGate}>
                Read the licence…
              </Button>
            )}
          </SettingRow>
        </>
      )}
      <Dialog open={gateOpen} onOpenChange={(next) => (next || !accepting) && setGateOpen(next)}>
        <ModalPanel title="JetBrains licence" description={eula ? `IntelliJ engine, build ${eula.build}` : undefined} busy={accepting}>
          <ModalBody>
            {eula ? (
              <pre tabIndex={0} className={cn(CONSOLE, "max-h-80 overflow-x-hidden overflow-y-auto whitespace-pre-wrap")}>
                {eula.text}
              </pre>
            ) : eulaError ? null : (
              <LoadingLine label="Downloading the engine to read its licence…" />
            )}
            <ErrorLine error={eulaError} />
          </ModalBody>
          <DialogFooter onCancel={() => setGateOpen(false)} confirmLabel="Accept and turn on" pending={accepting} disabled={!eula} onConfirm={accept} />
        </ModalPanel>
      </Dialog>
    </SettingSection>
  );
}
