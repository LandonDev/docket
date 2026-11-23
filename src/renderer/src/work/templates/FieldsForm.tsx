import { useRef, useState, type KeyboardEvent } from "react";
import type { Template } from "@shared/work/templates";
import { ChevronLeft } from "../../chrome/icons";
import { DialogFooter, ErrorLine } from "../../chrome/ConfirmDialog";
import { Field } from "../../chrome/DialogField";
import { ModalBody } from "../../chrome/Modal";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";

/**
 * A template's fields, asked before its file is made (docs/agents/work-templates.md
 * "The fields"): one Field per field in the file's order, the first focused,
 * Return in one moving to the next and in the last making the file. Create is
 * never greyed: a field left empty stays in the file as written. While the make
 * runs Create spins and the fields are read only; the host's refusal is one red
 * line under them, in its words, announced as it arrives, the values and focus
 * left as they are. `onBack` is there when he came from the tiles; its chevron
 * sits on the content's edge. Once its file was made but did not open (`made`),
 * the fields hold what was sent, read only, and the primary says Open: it opens
 * that file, and nothing is made again.
 */
export function FieldsForm({
  template,
  pending,
  error,
  made,
  onBack,
  onCancel,
  onCreate,
}: {
  template: Template;
  pending: boolean;
  error: string | null;
  /** Its file was made but did not open: the values it was made with. */
  made?: { values: Record<string, string> };
  onBack?: () => void;
  onCancel: () => void;
  onCreate: (fields: Record<string, string>) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() => made?.values ?? {});
  const fixed = pending || !!made;
  const inputs = useRef<(HTMLInputElement | null)[]>([]);
  const create = () => {
    if (pending) return;
    // Only what he typed: an empty field is not sent, so the file keeps it as written.
    const typed = Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim() !== ""));
    onCreate(typed);
  };
  const onKey = (index: number) => (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    const next = inputs.current[index + 1];
    if (next) next.focus();
    else create();
  };
  return (
    <form
      className="contents"
      onSubmit={(event) => {
        event.preventDefault();
        create();
      }}
    >
      <ModalBody>
        {template.fields.map((name, i) => (
          <Field key={name} label={name}>
            <Input
              ref={(el) => {
                inputs.current[i] = el;
              }}
              autoFocus={i === 0}
              readOnly={fixed}
              value={values[name] ?? ""}
              spellCheck={false}
              onChange={(event) => setValues((v) => ({ ...v, [name]: event.target.value }))}
              onKeyDown={onKey(i)}
            />
          </Field>
        ))}
        {/* Always there, so a refusal that lands in it is read out. */}
        <div role="alert" data-fields-error="" className="contents">
          <ErrorLine error={error} />
        </div>
      </ModalBody>
      <DialogFooter
        start={
          onBack ? (
            // The ghost's own padding is pulled back, so the chevron stands on the labels' edge.
            <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={onBack} className="-ms-3">
              <ChevronLeft />
              Back
            </Button>
          ) : undefined
        }
        onCancel={onCancel}
        confirmLabel={made ? "Open" : "Create"}
        pending={pending}
      />
    </form>
  );
}
