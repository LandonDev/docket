// bun run ui:preview src/renderer/src/chrome/ConnectionLine.fixtures.tsx#ConnectionLineGallery --shot --fresh
// Export ConnectionLineGallery. A fixed time holds the retry count. Reconnect and pairing need a live host.
import { degradedText, type Degraded, type EnvironmentStatus } from "../lib/connection";
import { ConnectionLineView } from "./ConnectionLine";

const now = Date.UTC(2026, 9, 21, 15, 20);
const noop = () => {};
const states: { kind: Degraded["kind"]; lastError?: string; nextRetryAt?: number }[] = [
  { kind: "connecting" },
  { kind: "reconnecting", nextRetryAt: now + 8_000 },
  { kind: "offline" },
  { kind: "offline", lastError: "No network here" },
  { kind: "offline", lastError: "Host identity changed" },
  { kind: "unauthorized", lastError: "This key was refused" },
];

export function ConnectionLineGallery() {
  return (
    <div className="flex flex-col gap-4">
      {[768, 420].map((width) => (
        <section key={width} className="max-w-full border border-border" style={{ width }}>
          {states.map(({ kind, lastError, nextRetryAt }, index) => {
            const status = { transport: kind, lastError: lastError ?? null, nextRetryAt: nextRetryAt ?? null } as EnvironmentStatus;
            return <ConnectionLineView key={index} kind={kind} text={degradedText("The box", { kind, status }, now)} onRetry={noop} onPair={noop} />;
          })}
        </section>
      ))}
    </div>
  );
}
