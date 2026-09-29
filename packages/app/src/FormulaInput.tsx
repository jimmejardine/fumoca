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
   * The sheet whose cells can be clicked to insert references (point mode). If not given, the
   * sheet the input sits in (the in-cell editor, inside a grid).
   */
  sheetId?: string | undefined;
}

/** The page's Mantine colour scheme, for components rendered outside Mantine's context. */
export const pageColorScheme = (): ColorScheme =>
  document.documentElement.getAttribute("data-mantine-color-scheme") === "dark" ? "dark" : "light";

/** Splits formula text into plain runs and cell references, each reference in its colour. */
function highlight(text: string, scheme: ColorScheme): ReactNode[] {
  const colors = referenceColors(text, scheme);
  const parts: ReactNode[] = [];
  let at = 0;
  for (const { key, start, end } of formulaSpans(text)) {
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
  const latest = useRef({ value, onChange, sheetId });
  latest.current = { value, onChange, sheetId };
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
    if (next.sheetId) publishDraft({ sheetId: next.sheetId, text: latest.current.value });
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
  useEffect(() => {
    const sheet = target.current?.sheetId;
    if (sheet) publishDraft({ sheetId: sheet, text: value });
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
        {highlight(value, scheme ?? pageColorScheme())}
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
