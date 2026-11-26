import { ArrowLeft } from "../../chrome/icons";
import { Button } from "../../components/ui/button";

/**
 * The way back, one shape on every Work screen inside a view (docs/DESIGN.md "Project screens"; People's person page, a
 * meeting's page): a 24px arrow, where it goes, then where he is, muted. Where it goes is never cut: a narrow header
 * cuts the name after it alone.
 */
export function BackTitle({ back, name, onBack }: { back: string; name: string | undefined; onBack: () => void }) {
  return (
    <span className="flex min-w-0 items-center gap-1 font-medium text-foreground">
      <Button type="button" variant="ghost" size="icon-xs" aria-label={`Back to ${back}`} className="-ms-1.5 shrink-0 text-muted-foreground" onClick={onBack}>
        <ArrowLeft />
      </Button>
      <span className="shrink-0">{back}</span>
      {name ? <span className="min-w-0 truncate font-normal text-muted-foreground">{name}</span> : null}
    </span>
  );
}
