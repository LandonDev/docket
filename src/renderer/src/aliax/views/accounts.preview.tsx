import { Page } from "@renderer/components/page";
import { BusyLabel, Button } from "@renderer/components/ui/button";
import { AccountsView, type AccountsViewProps } from "./accounts";

/**
 * The Accounts page's frame around its view, drawn with no snapshot, for
 * `bun run ui:preview src/renderer/src/aliax/views/accounts.preview.tsx#AccountsPagePreview
 * --width 1400`: the page at the pane's width, so the table and the stacked
 * form show at the widths they ship at. Rendered by nothing in the app.
 */
export function AccountsPagePreview(props: AccountsViewProps) {
  return (
    <Page
      title="Accounts"
      width="table"
      actions={
        // The page's Refresh as pages.tsx draws it, so the title line's edge shows against the sections' ⋯.
        <Button variant="ghost" size="sm">
          <BusyLabel busy={false} label="Refresh" align="end" />
        </Button>
      }
    >
      <AccountsView {...props} />
    </Page>
  );
}
