// bun run ui:preview src/renderer/src/aliax/pages.preview.tsx#AccountsPageFailed
// The two pages themselves over a stand-in `window.aliax`, for what only the page draws: its title line's verb and a
// list that fails to read. Stats' charts draw blank here (no measured frame): views/stats.preview.tsx draws them.
// Rendered by nothing in the app.
import { useState } from "react";
import accountsFixtures from "./views/accounts.fixtures";
import { STATS } from "./views/stats.fixtures";
import { AccountsPage, StatsPage } from "./pages";

const views = accountsFixtures[0]!.props.views;
const idle = async () => ({ ok: true });

/** Sets the stand-in before the page's first read, then draws it. */
function With({ listServices, children }: { listServices: () => Promise<unknown>; children: React.ReactNode }) {
  const [ready] = useState(() => {
    (window as unknown as { aliax: Record<string, unknown> }).aliax = {
      ...(window as unknown as { aliax?: Record<string, unknown> }).aliax,
      listServices,
      onAccountsChanged: () => () => {},
      stats: async () => ({ ...STATS, generatedAt: Date.now() }),
      statsStatus: async () => ({ indexing: false, filesDone: 40, filesTotal: 40, rows: 1200 }),
      statsReindex: idle,
    };
    return true;
  });
  return ready ? <>{children}</> : null;
}

/** The first read of the accounts refused: one red line with Retry, no bones. */
export function AccountsPageFailed() {
  return (
    <With listServices={() => Promise.reject(new Error("vault: EACCES"))}>
      <AccountsPage />
    </With>
  );
}

/** The page with its rows: Refresh on the title line, the Meta keys by their last four. */
export function AccountsPageTitle() {
  return (
    <With listServices={async () => views}>
      <AccountsPage />
    </With>
  );
}

/** Stats' title line: Reindex alone. */
export function StatsPageTitle() {
  return (
    <With listServices={async () => views}>
      <StatsPage />
    </With>
  );
}
