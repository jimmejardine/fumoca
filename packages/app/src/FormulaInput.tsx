import { formulaReferences } from "@fumoca/engine";
import { type InputHTMLAttributes, type ReactNode, useLayoutEffect, useRef } from "react";
import { type ColorScheme, referenceColors } from "./dependencyColors";
import classes from "./FormulaInput.module.css";

export interface FormulaInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "className"> {
  value: string;
  onChange: (value: string) => void;
  /** Classes for the frame around the text: size, border and background. */
  className?: string | undefined;
  /** The colour scheme for reference colours; read from the page if not given. */
  scheme?: ColorScheme | undefined;
}

/** The page's Mantine colour scheme, for components rendered outside Mantine's context. */
export const pageColorScheme = (): ColorScheme =>
  document.documentElement.getAttribute("data-mantine-color-scheme") === "dark" ? "dark" : "light";

/** Splits formula text into plain runs and cell references, each reference in its colour. */
function highlight(text: string, scheme: ColorScheme): ReactNode[] {
  const colors = referenceColors(text, scheme);
  const parts: ReactNode[] = [];
  let at = 0;
  for (const { address, start, end } of formulaReferences(text)) {
    if (start > at) parts.push(text.slice(at, start));
    parts.push(
      <span key={start} data-reference={address} style={{ color: colors.get(address) }}>
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
 */
export function FormulaInput({ value, onChange, className, scheme, ...props }: FormulaInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const syncScroll = () => {
    const input = inputRef.current;
    const mirror = mirrorRef.current;
    if (input && mirror) mirror.style.transform = `translateX(${-input.scrollLeft}px)`;
  };
  // The input may scroll when its value changes (typing at the end of long text).
  // biome-ignore lint/correctness/useExhaustiveDependencies: value is a deliberate trigger
  useLayoutEffect(syncScroll, [value]);
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
        onScroll={syncScroll}
        onSelect={syncScroll}
        onKeyUp={syncScroll}
      />
    </div>
  );
}
