// What `bun run ui:preview src/renderer/src/work/formats/ToolchainRow.tsx#ToolchainRowView` draws.
const GB = 1024 * 1024 * 1024;
const t = (name: string, version: string, ok: boolean, bytes = 0, error?: string) => ({ name, pillar: "toolchain", version, licence: "", ok, bytes, ...(error ? { error } : {}) });

export default [
  { name: "The box", props: { error: null, report: { tools: [t("ffmpeg", "9.0.2", true, 0.17 * GB), t("ironcalc", "0.9.1", true, 0.01 * GB), t("libreoffice", "26.8.3", true, 0.72 * GB), t("python", "3.12.16", true, 0.22 * GB), t("venv", "3.12.16", true, 0.01 * GB)] } } },
  { name: "A tool that did not install", props: { error: null, report: { tools: [t("ironcalc", "0.9.1", true, 0.01 * GB), t("python", "3.12.16", true, 0.22 * GB), t("ffmpeg", "9.0.2", false, 0, "checksum mismatch"), t("libreoffice", "26.8.3", false, 0, "not offered on win32-x64")] } } },
  { name: "Never installed", props: { error: null, report: { tools: [] } } },
  { name: "Loading", props: { error: null } },
  { name: "Work is off there", props: { error: "Work is off on this host" } },
];
