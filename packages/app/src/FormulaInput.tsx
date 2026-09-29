import {
  type InputHTMLAttributes,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";
import { type ColorScheme, formulaSpans, referenceColors } from "./dependencyColors";
import classes from "./FormulaInput.module.css";
import {
  clearPointTarget,
  type Insertion,
  insertReference,
  type PointTarget,
  publishDraft,
  setPointTarget,
} from "./pointing";

export interface FormulaInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "className"> {
  value: string;
  onChange: (value: string) => void;
  /** Classes for the frame around the text: size, border and background. */
  className?: string | undefined;
  /** The colour scheme for reference colours; read from the page if not given. */
  scheme?: ColorScheme | undefined;
  /**
   * The sheet the formula belongs to: clicked cells on it are inserted as plain addresses, and
   * the grids outline its references as it's typed. If not given, the sheet the input sits in (the
   * in-cell editor, inside a grid); with neither, clicked cells always carry their sheet's name.
   */
  sheetId?: string | undefined;
  /**
   * The text is a single cell reference or name, without a leading "=" (the scenario's cell
   * pickers): it's coloured and outlined like a reference in a formula.
   */
  reference?: boolean | undefined;
  /**
   * Handles a clicked cell (point mode) instead of inserting it at the caret; returns whether it
   * took it. Reference fields use it to take the whole reference at once.
   */
  onPoint?: ((reference: string) => boolean) | undefined;
}

/**
 * Some sheet to outline a reference field's text against: its references carry their sheets (or
 * are names), so any open sheet will do.
 */
const firstSheet = (input: HTMLElement): string | undefined =>
  input.ownerDocument.querySelector<HTMLElement>("[data-sheet]")?.dataset.sheet;

/** The formula bar's look (a Mantine xs input), for formula fields elsewhere. */
export const boxedFormulaInput = classes.boxed;

/** The page's Mantine colour scheme, for components rendered outside Mantine's context. */
export const pageColorScheme = (): ColorScheme =>
  document.documentElement.getAttribute("data-mantine-color-scheme") === "dark" ? "dark" : "light";

/**
 * Splits formula text into plain runs and cell references, each reference in its colour. A lone
 * reference (`reference`) is read as if it were a formula.
 */
function highlight(text: string, scheme: ColorScheme, reference = false): ReactNode[] {
  const formula = reference ? `=${text}` : text;
  const shift = reference ? 1 : 0;
  const colors = referenceColors(formula, scheme);
  const parts: ReactNode[] = [];
  let at = 0;
  for (const span of formulaSpans(formula)) {
    const { key } = span;
    const start = span.start - shift;
    const end = span.end - shift;
    if (start > at) parts.push(text.slice(at, start));
    parts.push(
      <span key={start} data-reference={key} style={{ color: colors.get(key) }}>
        {text.slice(start, end)}
      </span>,
    );
    at = end;
  }
  if (at < text.length) parts.push(text.slice(at));
  return parts;
}

/**
 * A text input that colours the cell references in a formula (SPECS.md §6.5), each in the colour
 * of that cell's dependency border. The input's own text is transparent, over a mirror of it that
 * carries the colours and scrolls with it.
 *
 * While it has focus, it's the point target: clicking a cell of its sheet inserts the cell's
 * address at the caret, when a reference can go there (SPECS.md §6.1).
 */
export function FormulaInput({
  value,
  onChange,
  className,
  scheme,
  sheetId,
  reference = false,
  onPoint,
  onFocus,
  onBlur,
  onKeyDown,
  ...props
}: FormulaInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const syncScroll = () => {
    const input = inputRef.current;
    const mirror = mirrorRef.current;
    if (input && mirror) mirror.style.transform = `translateX(${-input.scrollLeft}px)`;
  };

  // Point mode reads the latest value and callbacks through refs: the target lives while focused.
  const latest = useRef({ value, onChange, sheetId, onPoint });
  latest.current = { value, onChange, sheetId, onPoint };
  /** The text the grids outline: a lone reference is outlined as a formula of it. */
  const draftText = (text: string) => (reference ? `=${text}` : text);
  const lastInsertion = useRef<Insertion | null>(null);
  const pendingCaret = useRef<number | null>(null);
  const target = useRef<PointTarget | null>(null);
  const register = () => {
    const input = inputRef.current;
    if (!input) return;
    const next: PointTarget = {
      sheetId:
        latest.current.sheetId ??
        input.closest<HTMLElement>("[data-sheet]")?.dataset.sheet ??
        undefined,
      insert: (address) => {
        const handle = latest.current.onPoint;
        if (handle) return handle(address);
        const inserted = insertReference(
          latest.current.value,
          input.selectionStart ?? latest.current.value.length,
          input.selectionEnd ?? latest.current.value.length,
          address,
          lastInsertion.current,
        );
        if (!inserted) return false;
        lastInsertion.current = inserted.inserted;
        pendingCaret.current = inserted.caret;
        latest.current.onChange(inserted.value);
        return true;
      },
      pointed: () => {
        const last = lastInsertion.current;
        const { value } = latest.current;
        const caret = pendingCaret.current ?? input.selectionStart;
        if (!last || last.value !== value || caret !== last.end) return null;
        if (pendingCaret.current === null && input.selectionEnd !== last.end) return null;
        return value.slice(last.start, last.end);
      },
    };
    target.current = next;
    setPointTarget(next);
    const draftSheet = next.sheetId ?? firstSheet(input);
    if (draftSheet) publishDraft({ sheetId: draftSheet, text: draftText(latest.current.value) });
  };
  const unregister = () => {
    if (target.current) {
      clearPointTarget(target.current);
      publishDraft(null);
    }
    target.current = null;
    lastInsertion.current = null;
  };
  // While focused, the text is the draft whose references the grids outline.
  // biome-ignore lint/correctness/useExhaustiveDependencies: draftText only depends on reference
  useEffect(() => {
    const input = inputRef.current;
    if (!target.current || !input) return;
    const sheet = target.current.sheetId ?? firstSheet(input);
    if (sheet) publishDraft({ sheetId: sheet, text: draftText(value) });
  }, [value]);
  // An input focused on mount (autoFocus) may be focused before React's handler is attached.
  // biome-ignore lint/correctness/useExhaustiveDependencies: register and unregister use refs
  useEffect(() => {
    if (document.activeElement === inputRef.current) register();
    return unregister;
  }, []);

  // The input may scroll when its value changes (typing at the end of long text). After a
  // reference was inserted, the caret goes after it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: value is a deliberate trigger
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (input && pendingCaret.current !== null) {
      input.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
    syncScroll();
  }, [value]);
  return (
    <div
      className={[classes.frame, className].filter(Boolean).join(" ")}
      data-disabled={props.disabled || undefined}
    >
      <div ref={mirrorRef} className={classes.mirror} aria-hidden>
        {highlight(value, scheme ?? pageColorScheme(), reference)}
      </div>
      <input
        {...props}
        ref={inputRef}
        className={classes.input}
        value={value}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => onChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          // Keys typed here are for this input. RevoGrid listens for keys on the whole document,
          // and would otherwise take a typed character as the start of editing its focused cell.
          event.stopPropagation();
          onKeyDown?.(event);
        }}
        onFocus={(event) => {
          register();
          onFocus?.(event);
        }}
        onBlur={(event) => {
          unregister();
          onBlur?.(event);
        }}
        onScroll={syncScroll}
        onSelect={syncScroll}
        onKeyUp={syncScroll}
      />
    </div>
  );
}
