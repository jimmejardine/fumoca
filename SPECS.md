# fumoca: Specifications

This document holds the detailed specifications for fumoca. For a high-level overview, see [README.md](README.md).

> **Note:** Items marked **(proposed)** are suggested designs that haven't been confirmed yet. Open questions are tracked in [TBD.md](TBD.md).

---

## 1. Goals

1. Give casual users the power of Monte Carlo simulation, with no statistics or programming knowledge required.
2. Make it as easy to use as Excel: a familiar grid, formulas and cell references. Function names and behaviour match Excel's **as closely as possible**, so Excel users can move over and get up to speed quickly (§4.4).
3. Build it entirely in TypeScript and run it in the browser.

### Non-goals (for now)

- Importing or exporting Excel (`.xlsx`) files
- Implementing *every* Excel function. The library grows by priority, but every function that *is* implemented behaves like Excel's (§4.4).
- Advanced statistical modelling aimed at expert users (for example, custom samplers or MCMC)

---

## 2. Workbook model

- A **workbook** is one model. It contains one or more **worksheets**.
- Each worksheet has a unique name within its workbook.
- There are two kinds of worksheet:
  1. **Standard worksheet**: a free-form grid of cells, like a normal spreadsheet.
  2. **Time-series worksheet**: a worksheet with a built-in time dimension (see §5).

---

## 3. Grid and cells

- The grid has rows and columns, addressed A1-style (column letters, row numbers).
- A cell accepts the same kinds of content as an Excel cell, plus distributions:
  - **Nothing** (empty)
  - **A value**:
    - number
    - text
    - date: every date carries a **granularity** (hour, day, week, month, quarter or year) at all times (§3.1)
    - boolean
  - **A formula**: an expression starting with `=`
  - **A distribution**: a probability distribution such as normal, uniform or lognormal (see §6)
- Distributions are a first-class kind of cell content and the core feature of fumoca. They can be entered:
  - directly, for example `=NORMAL(100, 10)`
  - through a guided distribution picker (§6.2)
  - inside a larger formula, for example `=A1 * UNIFORM(0.9, 1.1)`, which makes the result uncertain too
- Any cell whose value depends on a distribution is itself uncertain. The engine builds up that cell's simulated distribution automatically (§6).
- Cells show their evaluated value, the **answer**, never the formula (§6.5).
- **Formula bar** (below the toolbar):
  - Shows the selected cell's address and its raw contents (the formula or value), and lets you edit them.
  - **Enter** or **Tab** commits the edit and recalculates, then moves the selection down one row, as in Excel.
  - **Escape** reverts the edit.
  - Leaving the bar with changes also commits them.
- **In-grid editing:**
  - **F2**, double-click or typing opens an editor in the cell itself.
  - F2 and double-click show the cell's raw formula or value; typing starts a new entry.
  - Enter commits and Escape cancels.
- **The name box (implemented)**, left of the formula bar, as in Excel:
  - It shows the selected cell's name, or its address if it has none. Clicking in selects the text.
  - **Enter:**
    - typing an address (`C12`, `Inputs!B3`) or an existing name, then Enter, jumps there, opening its sheet if needed;
    - typing a new name, then Enter, names the selected cell, or renames it;
    - an invalid name shows why.

    After a jump or a naming, the keyboard returns to the grid.
  - **Dropdown:** lists the named cells, this sheet's first (A–Z, with addresses), then the other sheets' (A–Z, with `Sheet!address`). Choosing one jumps to it. When the selected cell is named, it also offers to remove the name.
  - Arrow Down commits like Enter and moves down; Arrow Up commits and moves up.
- **Point mode:** while a formula is being edited, in the formula bar or in the cell, clicking a cell inserts its address at the caret instead of selecting it, as in Excel.
  - It applies where a reference can go: after `=`, `(`, `,` or an operator (ignoring spaces).
  - Clicking again straight away replaces the address just inserted. So `=B1*`, then clicking A1 and then A2, gives `=B1*A2`.
  - Elsewhere, for example right after a number, a click commits the edit and selects the clicked cell, as before.
  - A click on a cell of another sheet, open side by side, inserts it with its sheet name (`Sheet2!A1`).
  - **Arrow keys point too, in the cell editor:** where a reference can go, an arrow inserts the neighbouring cell of the edited cell, and further arrows move that reference, which is outlined as it moves. After a click, arrows move on from the clicked cell. Anywhere else, arrows behave as before: Up and Down commit and move. The formula bar's arrows always move the caret.
  - Only single cells can be pointed at, with no dragged ranges.
- **Syntax errors are kept:** a formula with a syntax error is committed as typed, unlike Excel, so it can be fixed rather than retyped. The cell shows `#ERROR!` with the reason in its tooltip, and cells that refer to it show errors too.
- **Copying and filling formulas (implemented), as in Excel:**
  - Copying puts the cells' shown answers on the clipboard, so pasting into another app gives what's shown. The grid also remembers the copied cells' inputs and positions.
  - Pasting into a grid, on any sheet, checks whether the clipboard still holds that copy. If so, it pastes the inputs; otherwise the plain text.
  - In a pasted formula, relative references move by the distance from the copied cell to the pasted one, and `$`-anchored columns and rows stay put. This applies to references to other sheets and to lookup time cells too. A larger paste range repeats the copy, each tile shifted.
  - The fill handle does the same from the cells it fills from.
  - A reference that would move off the grid becomes `#REF!`, and the cell shows `#REF!`.
- Standard spreadsheet behaviour is expected:
  - Select cells, move with the keyboard, edit in place and in a formula bar
  - Copy and paste, with relative and absolute (`$A$1`) references adjusted
  - Fill down and fill right
  - Undo and redo
  - Insert and delete rows and columns, with references updated to match

### 3.1 Dates and granularity

Every date value in fumoca is **tagged with a granularity** at all times. A date is not just a point in time. It identifies a *period*: an hour, day, week, month, quarter or year.

- **Default granularity when a date is entered:**

  | Entered as | Granularity | Displayed as |
  |---|---|---|
  | `2027-01-15T09`, or a date with a time | hour | `2027-01-15 09:00` |
  | `2027-01-15`, `15/01/2027`, `DATE(2027,1,15)`, `TODAY()` | day | `2027-01-15` (cell number format applies) |
  | `2027-W05` | week | `2027-W05` |
  | `2027-01`, `Jan 2027` | month | `2027-01` |
  | `2027-Q1` | quarter | `2027-Q1` |
  | `2027` entered as a date (for example through a date-formatted cell or `PERIOD.YEAR`) | year | `2027` |

  A bare number such as `2027` stays a **number** unless the cell is formatted as a date or it is converted with a function. This preserves Excel behaviour.
- **Period boundaries:** week, quarter and year boundaries follow the same defaults as time-series anchors (§5.2): weeks start on Monday, and quarters and years follow the calendar.
- **Converting between granularities:** functions change a date's granularity. Their names must not clash with Excel's (§4.4):

  | Function | Result |
  |---|---|
  | `PERIOD.HOUR(d)`, `PERIOD.DAY(d)`, `PERIOD.WEEK(d)`, `PERIOD.MONTH(d)`, `PERIOD.QUARTER(d)`, `PERIOD.YEAR(d)` | The period of that granularity containing `d` (when going coarser), or the first sub-period of `d` (when going finer) |
  | `PERIOD.START(d)`, `PERIOD.END(d)` | The first or last *day* of `d`'s period |
  | `GRANULARITY(d)` | The granularity of `d` as text, for example `"quarter"` |

  Example: `=PERIOD.QUARTER(A1)`, where `A1` holds `2027-02-15`, gives `2027-Q1`.
- **Excel compatibility (§4.4):**
  - Underneath, a date is still an Excel serial number: the serial of the **start** of its period.
  - Excel date functions (`YEAR`, `MONTH`, `DAY`, `WEEKDAY`, `EDATE`, `EOMONTH`, `DATEDIF` and so on) work on that serial and behave exactly as in Excel.
  - Excel-style formulas that only ever use day-granular dates behave identically to Excel.
- **Arithmetic: numbers are counted in units of the date's own granularity.**
  - `d + n` / `d - n` moves *n* whole periods at `d`'s granularity, and the result keeps that granularity:

    | Expression | Result |
    |---|---|
    | `2027-01-15 + 1` (day) | `2027-01-16` |
    | `2027-01 + 1` (month) | `2027-02` |
    | `2027-Q1 + 2` (quarter) | `2027-Q3` |
    | `2027-W52 + 1` (week) | `2028-W01` |
    | `2027-01-15T09 + 3` (hour) | `2027-01-15 12:00` |
    | `2027 + 1` (year) | `2028` |

  - For **day**-granular dates this is exactly Excel's behaviour, where `+1` is one day. Ordinary Excel date arithmetic is therefore unaffected.
  - **Subtracting two dates** of the same granularity gives the number of periods between them, for example `2027-Q3 - 2027-Q1` is `2`. **Combining two dates of different granularities** is a `#VALUE!` error, whether adding or subtracting. The user converts one of them first with `PERIOD.*`.
  - Adding two dates of the *same* granularity, for example `2027-Q1 + 2027-Q3`, has no meaningful result, so it's also a `#VALUE!` error **(proposed)**.
  - Fractional *n* is truncated towards zero **(proposed)**.
- **Comparison (proposed):** dates compare by their start serial. `=` between different granularities is true only if both the start serial and the granularity match.

---

## 4. Formulas

### 4.1 Syntax

- Formulas start with `=`.
- Arithmetic operators: `+ - * / ^`, plus unary minus
- Comparison operators: `= <> < > <= >=`
- Text concatenation: `&`
- References:
  - Single cell: `A1`, `$A$1`, `A$1`, `$A1`
  - Range: `A1:B10`
  - Another worksheet: `Sheet2!A1`, or `'My Sheet'!A1:B10` when the name has spaces
    - **Implemented** for single cells, as in Excel. A name is quoted when it isn't a plain identifier, and a quote inside a name is doubled (`'It''s'!A1`). Sheet names match in any case.
    - An unknown sheet gives `#REF!`. Cycles across sheets give `#CIRC!`.
    - Sheets can't be renamed yet, so references never need rewriting.
  - Time-series structured reference: `Rates[Rate]@2027-01` (see §5.3)
- **Named cells (implemented):** a cell can be given a name, for example `Spot`, and formulas on any sheet can use it: `=Spot * EXP(Rate * Years)`.
  - **Scope:** names are workbook-wide and unique, regardless of case (`spot` and `Spot` are the same name). A cell has at most one name.
  - **Rules, as in Excel:**
    - a name starts with a letter or `_`, followed by letters, digits, `_` or `.`, up to 255 characters;
    - it can't look like a cell reference (`A1`, `Tax1`, `S0`);
    - it can't be `TRUE` or `FALSE`.

    A name followed by `(` is a function call, so function names like `SUM` can still be names.
  - **Renaming** a named cell rewrites every formula that uses the old name.
  - Removing a name leaves the formulas that use it showing `#NAME?` ("Unknown name …").
  - **Other behaviour:**
    - names are absolute: copying a formula doesn't change them;
    - clicking a named cell while writing a formula (point mode) inserts its name;
    - names are coloured and outlined as dependencies, like references.
  - Names are saved with each sheet in the workbook file.
  - **Not yet:** named ranges, names scoped to one sheet, and several names for one cell.

### 4.2 Function library (initial)

- **Math:** `SUM`, `AVERAGE`, `MIN`, `MAX`, `ROUND`, `ABS`, `SQRT`, `EXP`, `LN`, `POWER`
- **Logic:** `IF`, `AND`, `OR`, `NOT`, `IFERROR`
- **Lookup:** `INDEX`, `MATCH`, `VLOOKUP`, `HLOOKUP`, `XLOOKUP`, plus time-series lookups (§5.3)
- **Random (Excel built-ins):** `RAND`, `RANDBETWEEN`. See §4.4 for how they behave in fumoca.
- **Statistical (Excel built-ins):** `NORM.DIST`, `NORM.INV`, `NORM.S.DIST`, `NORM.S.INV`, `LOGNORM.DIST`, `LOGNORM.INV`, `BETA.DIST`, `BETA.INV`, `GAMMA.DIST`, `GAMMA.INV`, and similar, with Excel's exact names, arguments and parameterisation
- **Distributions:** see §6.2

### 4.3 Evaluation

- The formula engine builds a dependency graph across all worksheets.
- When a cell changes, only the cells that depend on it are recalculated.
- Circular references are detected and reported as an error in the cell. Iterative calculation is not supported at first.
- Error values follow Excel's: `#REF!`, `#DIV/0!`, `#NAME?`, `#VALUE!`, `#N/A`, `#NUM!`, `#SPILL!`. A circular reference shows an error in the cell (Excel only warns).

### 4.4 Excel compatibility

**Principle:** wherever fumoca has an equivalent of an Excel feature, it **matches Excel's names, arguments and behaviour as closely as possible**. Anyone who knows Excel should be able to type the formula they already know and get the answer they expect.

- **Function names and arguments:**
  - Use Excel's exact names, argument order, optional arguments and defaults, for example `XLOOKUP(lookup, lookup_array, return_array, [if_not_found], [match_mode], [search_mode])`.
  - Legacy Excel names (for example `NORMSINV`, `NORMDIST`) are accepted as aliases **(proposed)**.
- **Operators and precedence:**
  - Excel's precedence, including its quirks. For example, unary minus binds tighter than `^`, so `=-2^2` is `4`.
  - `&` for text concatenation.
  - `%` as a postfix operator (`=50%` is `0.5`).
- **Types and coercion:**
  - Excel's rules for coercing between numbers, text and booleans, for example `=TRUE+1` is `2` and `="3"*2` is `6`.
  - Text comparison is case-insensitive.
- **Dates:**
  - Dates are Excel-style serial numbers in the 1900 date system, with a granularity tag on top (§3.1), so date arithmetic (`=A1+30`) and functions such as `DATE`, `EDATE`, `EOMONTH`, `YEAR`, `MONTH` and `WEEKDAY` behave as in Excel.
  - **(Proposed)** Serial values match Excel from 1 March 1900 onwards. Excel's fictitious 29 February 1900 is not reproduced.
- **Arrays:**
  - Excel's **dynamic array** behaviour: a formula that returns an array spills into neighbouring cells, and `#SPILL!` is shown when it's blocked.
  - This covers `CHOLESKY`/`MMULT` (§6.2.1), time-series ranges (§5.3) and functions such as `SEQUENCE`, `FILTER` and `SORT`.
- **Error values:** Excel's error values, with the same propagation rules, and `IFERROR`/`IFNA` behaving the same way.
- **Excel's random functions:**
  - `RAND()` and `RANDBETWEEN()` are treated as **distributions**. `RAND()` behaves exactly like `UNIFORM(0, 1)` and is sampled once per iteration.
  - The common Excel Monte Carlo idiom `=NORM.INV(RAND(), mean, sd)` therefore works as a normal-distribution input with no changes.
- **Where fumoca goes beyond Excel:**
  - Distribution functions (§6.2), time-series structured references (§5.3), scenarios and sensitivity analysis.
  - Their names must **not** clash with any existing Excel function name.
  - They follow Excel's naming style: upper case, with dotted suffixes such as `.INV` and `.DIST`.
- **Documented deviations:** any deliberate difference from Excel's behaviour is listed in the user documentation with the reason. Examples:
  - Circular references are always errors, and there is no iterative calculation at first.
  - Adding a number to an hour-, week-, month-, quarter- or year-granular date moves by whole periods, not days (§3.1). Day dates behave exactly as in Excel.

---

## 5. Time-series worksheets

### 5.1 Purpose

Time-series worksheets hold data indexed by time, so that other worksheets can look values up by date or period. Typical contents:

- Historical sales
- Historical and projected unit costs
- Stock prices
- Assumed future interest rates

### 5.2 Structure

A time-series worksheet contains **only series columns**. It has no free-form cells.

- **Frequency:** each time-series worksheet defines one frequency: hourly, daily, weekly, monthly, quarterly or yearly.
- **Anchor date:** the time axis is aligned to an anchor date, which sets where each period starts. Sensible defaults for each frequency:

  | Frequency | Default alignment |
  |---|---|
  | Hourly | Top of the hour |
  | Daily | Midnight |
  | Weekly | Monday **(proposed)** |
  | Monthly | 1st of the month |
  | Quarterly | Start of the calendar quarter (Jan / Apr / Jul / Oct) |
  | Yearly | 1 January |

  The user can override the anchor, for example to align to a fiscal year starting 1 July, or weeks starting on Sunday.
- **Time axis:**
  - The worksheet automatically creates one row per period, at the chosen frequency, from the anchor.
  - Each row is an **entry point**: a slot where the user can enter a value for each series.
  - The time-axis column is read-only. Users never type dates into it.
- **Range:**
  - The user sets a start and an end period.
  - **(Proposed)** The axis can be extended at either end with one click ("add 12 more months"), or by entering a value in the first empty row after the end.
- **Series:**
  - Every column other than the time axis is a named **series**, for example `Sales`, `UnitCost` or `Rate`.
  - Every series has a **series type** (see §5.5), which sets sensible defaults for how the series is looked up.
  - Each entry can be a constant, a formula or a distribution. This allows uncertain projections, such as a future interest rate modelled as a distribution.
  - Empty entries are allowed. How lookups handle them is described in §5.3.
- **Changing frequency or anchor (proposed):** if entries already exist, the user is warned. Entries are then mapped to the new periods or discarded; they are never silently misaligned.
- **Hourly frequency (proposed):** timestamps are wall-clock local time with no time zone. This avoids daylight-saving surprises.

### 5.2.1 Current implementation

- **Creating one:** **Model → New series sheet** creates an **empty** "SeriesN": monthly, type Level, one value column called "Value".
- **First period sets the granularity:** while the time column is empty, the first period typed sets the sheet's granularity. For example, `2026-Q1` makes it Quarterly. After that, a period of another granularity is marked red rather than adopted.
- **Loose periods are fixed as typed:** in the time column, `2026-7` becomes `2026-07`, `2026-q1` becomes `2026-Q1`, and `2026-3-5` becomes `2026-03-05`.
- **Ctrl+; fills in a period:**
  - **In the grid:** it fills the time cell of the focused row.
  - **In the formula bar,** while editing a time cell: it fills the draft, and Enter commits it.
  - **What it fills:**
    - With no periods above that row: the current period (today, truncated to the sheet's granularity, e.g. `2026-09`, `2026-Q3`, `2026-W39`).
    - Otherwise: the latest period above, plus one.
- **Always one spare row:** the grid shows the used rows plus one empty row. Entering anything in it adds another.
- **Problems are shown at the bottom of the sheet:**
  - **Duplicate periods:** an error, on a pink background, naming the period and its rows.
  - **Periods out of order:** a beige warning, "Warning: your dates are out of order", with a **Sort now** button.
    - Sorting orders rows by period, ascending, and each row's values move with it.
    - Rows without a valid period go last, and empty rows are removed.
    - Formulas move unchanged, as in Excel.
- **Model → New sheet** adds a standard sheet.
- **Layout:** a series sheet has **no row numbers**. Its columns are headed by name: **Period** (the time column, column A) first, then the value columns (B, C, …).
  - Periods start at row 1.
  - A sheet can have several value columns, e.g. Open, High, Low, Close for a price series.
  - **Add value column** in the sheet's toolbar adds ValueN.
  - **Double-clicking a value column's header** renames it. Names must be unique (ignoring case), can't be "Period", and can't contain `[ ] @ '`.
- **Time column:** it can be edited. Any row whose time value is missing or doesn't match the sheet's granularity is shown red.
- **Sheet toolbar:** **Granularity** and **Type**. Changing the granularity re-checks every row.
- **Saving:** the settings are saved with the sheet (`series: { granularity, type, columns }` in the file). Files without `columns` get a single "Value" column.

### 5.3 Lookups: structured references

Other worksheets read time-series values with **structured references** of the form:

```
Sheet[Series]@When
```

| Example | Meaning |
|---|---|
| `Rates[Rate]@2027-01` | The `Rate` series for January 2027 |
| `Rates[Rate]@2027-Q1` | The `Rate` series for Q1 2027. If `Rates` is monthly, the months are aggregated (§5.4) |
| `Rates[Rate]@A1` | The `Rate` series at the date or period held in cell `A1` |
| `Rates[Rate]@(A1 + 30)` | Any expression that gives a date or period can go in brackets |
| `Sales[Units]@2027-01:2027-12` | A range of periods, returned as an array for `SUM`, `AVERAGE` and similar **(proposed)** |
| `'Interest Rates'[Base Rate]@2027` | Quotes around sheet names that contain spaces; square brackets allow spaces in series names |

**Period literals.** Each literal carries its own granularity:

| Granularity | Literal |
|---|---|
| Year | `2027` |
| Quarter | `2027-Q1` |
| Month | `2027-01` |
| Week | `2027-W05` |
| Day | `2027-01-15` |
| Hour | `2027-01-15T09` |

**Granularity of values from cells.** When the `@` part comes from a cell or an expression, the lookup uses the **granularity tag of the date** (§3.1). For example, if `A1` holds `2027-02-15` (a day), then `Rates[Rate]@A1` is a daily lookup and `Rates[Rate]@PERIOD.QUARTER(A1)` is a quarterly lookup. The lookup mapping config (§5.4) then decides how the lookup is resolved against the worksheet's frequency.

**Current implementation:**
- **Supported forms:** `Sheet[Column]@Period`, and `Sheet@Period` for the first value column.
  - The period is a literal, or a cell on the same sheet holding a period.
  - Sheet and column names are matched ignoring case.
- **Compiling:** the whole workbook compiles into one program. Each lookup resolves at compile time to the single series cell it names, so it compiles to an ordinary cross-sheet reference, and uncertain series values carry their uncertainty through.
- **Errors:**
  - `#N/A` when the period isn't in the time column, the value cell is empty, or the period has a different granularity from the sheet. The lookup mapping (§5.4) comes later.
  - `#REF!` for an unknown sheet or column, or a sheet that isn't a series sheet.
  - `#VALUE!` when the time cell doesn't hold a period. Calculated times aren't supported yet.

**Autocomplete.** The formula editor suggests sheet names, series names and period literals as the user types a structured reference.

**Uncertain values.** If the series entry is a distribution, the reference returns a sample, just like a reference to a distribution cell.

### 5.4 Lookup mapping config

Each time-series worksheet has a **lookup mapping config**. It decides how a lookup is resolved when the granularity of the lookup differs from the worksheet's own frequency.

> This config is expected to **grow in complexity over time**. It must be stored as a structured, versioned object per worksheet, with room for per-series overrides and new options without breaking existing workbooks.

#### Case 1: same granularity

The lookup returns the entry for that period directly.

#### Case 2: finer lookup (lookup more granular than the worksheet)

Example: a daily lookup into a monthly worksheet. The lookup is a point *within* or *between* periods. Options:

| Option | Behaviour |
|---|---|
| `hold` | Value of the period that contains the lookup (step function) |
| `previous` / `next` | Value of the previous or next period |
| `min` / `max` | Minimum or maximum of the two surrounding periods |
| `linear` | Linear interpolation between the surrounding periods, based on position within the period |
| `spread` | The period's value divided evenly across the finer periods. For example, monthly sales of 3,100 looked up daily in a 31-day month gives 100 per day. The natural choice for flows |

The default comes from the series type (§5.5).

#### Case 3: coarser lookup (lookup less granular than the worksheet)

Example: a quarterly lookup into a monthly worksheet. The lookup covers *several* periods, which have to be combined. Options:

| Option | Behaviour |
|---|---|
| `start` / `end` | First or last period in the window |
| `sum` | Total over the window, for flows such as sales |
| `average` | Simple average over the window |
| `expaverage` | Exponentially weighted average, with a configurable half-life or decay |
| `min` / `max` | Minimum or maximum over the window |

The default comes from the series type (§5.5).

#### Other settings in the config

- **Outside the axis:** error (default), carry the first/last value forward, or extrapolate **(proposed)**.
- **Empty entries:** error, skip (ignored in aggregations), carry the last value forward, or interpolate **(proposed)**.
- **Per-series overrides:** mostly handled by the series type (§5.5). Any setting can still be overridden for an individual series.
- **Per-reference overrides (proposed, later):** a single reference can override the config, for example `Rates[Rate]@2027-Q1{end}`.

#### How a setting is resolved

A setting is resolved in this order, from most specific to least specific:
1. The per-reference override
2. The per-series override
3. The **series-type default** (§5.5)
4. The worksheet default

#### Future directions

- Calendar-aware weighting, for example weighting days in a month by business days.
- Custom aggregation formulas.
- Seasonality-aware interpolation.

### 5.5 Series types

Every series declares a **type**. The type describes what kind of quantity the series holds, and many sensible defaults follow from it: lookup mapping, handling of empty entries, and display format. Users pick a type when they create a series, and can override any individual default afterwards.

| Type | What it is | Examples | Coarser lookup default | Finer lookup default | Empty entries default |
|---|---|---|---|---|---|
| **Flow** | An amount that builds up over a period | Sales, units shipped, costs incurred, cash flow | `sum` | `spread` | Treated as 0 **(proposed)** |
| **Level** | A value measured at a point in time | Stock price, inventory, account balance, headcount | `end` | `linear` | Carry last value forward **(proposed)** |
| **Rate** | A ratio or percentage that applies over a period | Interest rate, growth rate, inflation, margin % | `average` | `hold` | Error **(proposed)** |

Notes:
- Defaults marked **(proposed)** still need confirming.
- **Level and `end`:** for a level, the value at the end of the window is usually what people mean, for example the "Q1 stock price" is the closing price at the end of Q1. `average` stays available.
- **Display:** the type can also set the default number format, for example percentages for rates **(proposed)**.
- **Default type:** new series start as **Level** unless the user chooses otherwise **(proposed)**.
- **Adding types:** the list of types is designed to grow. Possible future types include a **compounding rate**, where coarser lookups compound rather than average, and a **categorical/label** type.

---

## 6. Monte Carlo simulation

### 6.1 Concept

- Any cell can hold a **distribution** in place of a fixed value.
- **The engine is always simulating.** There is no separate "run simulation" step. While a workbook is open, the engine keeps looping:
  1. Draw one sample from every distribution cell.
  2. Push those samples through every formula that depends on them, across all worksheets.
  3. Record the resulting value of every uncertain cell.
- Each loop is one **iteration**. Over many iterations, every dependent cell builds up its own **output distribution** (a simulated distribution of possible values), which the grid shows live.
- Every cell that depends on a distribution is effectively an output. The user doesn't have to mark outputs in advance.
- Cells that don't depend on any distribution are **deterministic**.
  - In the grid they look like normal spreadsheet values, with no histogram (§6.5).
  - The simulation backends still evaluate them in every iteration, as part of the whole model (§6.6).

### 6.2 Distribution functions (initial)

| Function | Description |
|---|---|
| `UNIFORM(min, max)` | Every value between min and max is equally likely |
| `NORMAL(mean, sd)` | Bell curve |
| `TRIANGULAR(min, mode, max)` | "Lowest, most likely, highest": good for casual users |
| `PERT(min, mode, max)` | Smoother version of the triangular distribution |
| `LOGNORMAL(mean, standard_dev)` | Positive, right-skewed values (for example prices). **Follows Excel's `LOGNORM.DIST`/`LOGNORM.INV` convention:** `mean` and `standard_dev` are the parameters of the underlying normal distribution, ln(X), not of X itself. So `LOGNORMAL(m, s)` is equivalent to `LOGNORM.INV(RAND(), m, s)`. |
| `DISCRETE(values, weights)` | Choose one value from a list with the given probabilities |
| `BERNOULLI(p)` | 1 with probability p, otherwise 0 (event happens or doesn't) |

- **Casual-user friendliness (proposed):** a guided dialog for entering distributions, such as "What's the lowest, most likely and highest value?", which then writes the formula.
  - For the lognormal, the dialog can ask for intuitive quantities, such as a median and a P90. It converts them to the underlying `mean` and `standard_dev` and writes an ordinary `LOGNORMAL(...)` formula, so the Excel-consistent parameters are always what is stored.
- **Samples per iteration:** each distribution cell is sampled once per iteration. Every formula that refers to that cell sees the same sample.

### 6.2.1 Correlated inputs: built from formulas, not engine-level

The engine has **no built-in correlation mechanism**. Every distribution cell is sampled independently. Correlated inputs are **built in the workbook from independent random inputs**, using ordinary formulas.

This keeps the sampling core (and the GPU kernel) simple. The formula library just needs the building blocks listed below.

**Method 1: linear transformation / Cholesky decomposition (Gaussian inputs)**

For two correlated normals with correlation ρ:

```
Z1:  =NORMAL(0, 1)
Z2:  =NORMAL(0, 1)
X1:  =mu1 + sd1 * Z1
X2:  =mu2 + sd2 * (rho * Z1 + SQRT(1 - rho^2) * Z2)
```

For more than two variables, the correlation matrix is factorised as `L·Lᵀ` (Cholesky), and the correlated vector is `mu + L·Z`.

**Method 2: copula (general and non-Gaussian inputs)**

1. Generate correlated standard normals `Z` as in Method 1.
2. Convert each to a uniform with the standard normal CDF: `U = NORM.S.DIST(Z)`.
3. Convert each uniform to the target distribution with its inverse CDF, for example `=LOGNORM.INV(U, mean_ln, sd_ln)` (Excel's function) or `=TRIANGULAR.INV(U, min, mode, max)` (fumoca's own).

This gives each variable any distribution it needs, while keeping the dependence structure of the Gaussian copula.

**Required building blocks in the function library:**
- **CDF and inverse CDF** for every built-in distribution in §6.2, for example `NORM.S.DIST`, `NORM.S.INV`, `LOGNORM.INV`, `BETA.INV` (Excel names, used where Excel has them), plus fumoca-only `UNIFORM.INV`, `TRIANGULAR.INV` and `PERT.INV`, named in the same style (§4.4).
- **Matrix functions** for correlating more than two variables: `CHOLESKY(range)` returns the lower-triangular factor, and `MMULT(a, b)` multiplies matrices **(proposed)**.
- All of these must also be implemented in WGSL for the GPU backend (§6.6).

**Making it easy for casual users (proposed, later):** a "correlate these inputs" helper. The user picks the cells and enters a correlation matrix, and the helper **writes the formula cells described above** into the workbook. The result stays visible, editable and ordinary. The helper never adds a hidden engine-level mechanism.

### 6.3 Continuous sampling behaviour

- **Starts on its own:** sampling begins as soon as the workbook contains a distribution. It continues until results have **settled** (see below), a hard cap is reached, or the user pauses it.
- **Retained values:** each uncertain cell keeps (retains) every sample it has built up since it was last reset. There is **no rolling window**. The model doesn't change between edits, so every retained sample stays valid and nothing is ever thrown away early.
- **Reset on edit:**
  - When the user edits a cell, the retained values of **that cell and all of its dependents** (on every worksheet) are reset, and they start building up again from zero.
  - Retained values of cells the edit doesn't affect, including the edited cell's precedents, are kept.
  - Analyses that pair samples across cells, such as the rank-correlation tornado (§6.5), only use iterations since the most recent reset of the cells involved.
- **Settling:** sampling stops once results are stable, not simply when a buffer is full.
  - **Settling is decided per group of connected cells:**
    - Every iteration samples all inputs together and pushes them through the whole model. Samples are *joint*, which the sensitivity and scenario features rely on.
    - A cell therefore can't stop on its own while a cell that depends on it still needs fresh draws.
    - Settling is decided for each group of cells linked by dependencies. A group stops when **every** uncertain cell in it has settled.
    - Unrelated parts of the workbook settle on their own.
  - **Settling criterion for a cell** (all must hold):
    1. **Minimum samples:** at least *n*ₘᵢₙ samples, for example 1,000, so a lucky early run can't settle.
    2. **Mean is stable:** the standard error of the mean (SD ÷ √n) is below a tolerance measured against the SD, for example 0.5% of the SD. The tolerance is measured against the SD, not the mean, so it still works when the mean is close to 0.
    3. **Tails are stable:** P5 and P95 have each moved by less than a tolerance, measured against the SD, over the last *k* checks.
  - **Precision setting (proposed):** a simple **Fast / Balanced / Precise** setting chooses the tolerances. Advanced users can set exact values.
  - **Hard cap:** a maximum number of retained samples per cell, for example 100,000. It limits memory and stops models that never settle. A cell that hits the cap without settling is flagged.
  - **Status:** each cell shows whether it is *sampling* or *settled*, with its sample count (§6.4).
  - **Reset restarts settling:** a reset (above) also clears a group's settled state, and sampling for that group resumes automatically.
- **Progressive, batched runs (implemented):**
  - Each engine evaluates its iterations in **batches**, contiguous ranges `[start, start + n)`.
  - Every batch is folded into per-cell running statistics (`CellAccumulator`: count, mean and variance merged with Chan's parallel formula, the first value, NaN/infinity flags, and a streaming histogram). Samples are then discarded.
  - **Memory depends on the batch size, not the total**, so CPU and GPU iterations can each go up to 1,000,000,000.
  - The grid refreshes about 5 times a second while batches arrive, and the status shows progress, e.g. `GPU 350,000 / 1,000,000 · CPU 10,000 / 10,000 · agree so far`.
  - A model edit or settings change cancels the run and starts a new one.
  - **Edits are debounced:** after a cell edit the new run waits for 500 ms without further edits; each edit restarts the wait, so a burst of edits runs once. The edited cells show what was typed straight away. Loading a model, sorting a series sheet, adding a sheet or changing settings recalculates at once.
  - **GPU batches:** the backend asks the adapter for its full storage-buffer limits. Its batch is the largest that fits one storage binding (outputs × iterations × 4 bytes), capped at 262,144, and the compiled pipeline is cached across batches.
  - **CPU batches:** 1,000 iterations per worker, and each worker receives the program once.
  - **The CPU–GPU comparison** (§6.7) runs incrementally over the first min(CPU, GPU, 100,000) iterations as both engines cover them.
  - **The engine runs in its own worker (implemented):**
    - Compiling, the GPU backend, the CPU worker pool, batch folding and the comparison all run in a dedicated engine worker.
    - The page only posts the model and receives compact snapshots (per cell: mean, SD, the value of a deterministic cell, and the histogram), so it never blocks during a run. Measured: no main-thread long tasks during a 1-billion-iteration GPU run alongside a 100-million-iteration CPU run.
    - The page's bundle emits the CPU worker script and passes its URL to the engine worker, because a worker's own bundle can't emit a nested worker.
  - **Fast feedback after an edit:**
    - Raw batches start at 8,192 iterations and double, so first results come quickly.
    - The edited cell shows the typed value immediately.
    - Until the primary engine reports, the grid shows the secondary engine's results.
  - **CPU workers summarize their own batches** after the raw phase, returning per-cell summaries instead of samples.
- **Memory at GPU speeds (proposed, after the GPU prototype §6.6):** if storing every raw sample becomes too costly, keep raw samples up to a limit, and after that only running summaries: a histogram, moments, and a quantile sketch such as t-digest.
- **Pause and resume:** the user can pause and resume sampling. This helps with large models or when saving battery.
- **Random seed:** optional, for reproducible results.
- **Correlation between inputs:** not an engine setting. Correlated inputs are built with formulas (§6.2.1).

### 6.4 Execution

- **Multi-core:** the engine runs on a **pool of Web Workers** so it uses all available CPU cores.
  - **Default pool size:** `navigator.hardwareConcurrency - 1` workers, with a minimum of 1. This leaves one core free for the main thread so the UI stays responsive.
  - **User setting:** the user can change the worker count, from 1 up to `hardwareConcurrency`. The change takes effect without reloading the workbook.
- **Sharing the work:**
  - Each worker holds its own copy of the compiled model.
  - Each worker runs independent iterations using its own random stream. The streams are derived from the master seed, so a seeded run still gives reproducible results for a given worker count.
  - Iterations are independent of each other, so they parallelise cleanly and workers never need to coordinate.
- **Merging results:** a coordinator merges the samples from all workers into each cell's sample buffer. It computes the statistics and sends them to the UI.
  - Workers run in **batches** (for example, a few hundred iterations at a time).
  - Results reach the UI a few times per second, not once per sample.
  - **Transport:** samples are passed with plain `postMessage` using **transferable `ArrayBuffer`s**, for example one `Float64Array` per batch. This is the most widely supported mechanism, and transferring avoids copying. The traffic between workers and the coordinator is small enough that shared memory isn't needed.
  - `SharedArrayBuffer` is **not** used. The app therefore needs no cross-origin isolation (COOP/COEP) headers, which keeps both fumoca.com and self-built runs simple to host.
- **Handling edits:** when the user edits a cell, the new compiled model is sent to every worker. Each worker drops any work it has in progress for the affected cells.
- The evaluation path is optimised for repeated evaluation: the dependency graph is compiled once per edit, then evaluated many times.
- The UI shows each cell's sample count, or a "converging / settled" status, so users can tell how reliable the numbers are.

### 6.5 Results

Every uncertain cell shows live results.

**Every cell (implemented):**
- **Root cells are bold.** A root cell's contents refer to no other cell: a number, or a formula or distribution built only from constants, such as `100`, `=1+2` or `=NORMAL(100, 10)`.
  - Formula results, such as `=B1*2` or `=NORMAL(B1, 10)`, are normal weight.
  - So are text labels.
- **Dependency highlighting:** when the selection is on a formula cell, each cell its formula references gets a thin (2px) coloured border. The formula bar and the in-cell editor show each reference in the same colour as its cell's border.
  - **Colours:** a deterministic sequence around the colour wheel. The i-th distinct reference, in order of first appearance, has hue 0° + i × the golden angle (≈137.5°), so neighbouring colours are far apart and blue, the selection colour, comes late. They are darker on the light theme and lighter on the dark theme. A repeated reference keeps its colour.
  - While a formula is being edited, in the formula bar or in the cell, the colours and borders follow the text as it's typed or pointed. Otherwise they follow the selected cell's committed formula.
  - References to other sheets (`Sheet2!A1`) are highlighted too; the border shows wherever that sheet is open.
  - Series lookups (`Prices[Close]@2026-10`) aren't highlighted; a lookup's time cell (`Prices@A5`) is.
- **Deterministic numbers:** Excel "General" style (up to 10 significant digits, no thousands separators), right-aligned.
- **In-cell histogram:** every uncertain cell's background shows a faint histogram of its samples. It's drawn as a stretched inline SVG and follows light/dark mode.
  - It uses a 64-bin **streaming histogram** (`StreamingHistogram`, `packages/engine/src/histogram.ts`), ready for continuous sampling:
    - The first batch sets the range: its [min, max], padded by 10%.
    - A later sample outside the range doubles the range towards that side and merges neighbouring bins in pairs.
    - Bin edges lie on a grid anchored at zero, so the doubled grids nest exactly and the merged counts are exact. Old samples are never re-read.
  - Deterministic cells, labels and errors have no histogram.
- **Uncertain cells:** `mean ± SD`, centred. The SD is shown to 2 significant digits, with the mean rounded to the same decimal place, for example `100 ± 10` or `1.000 ± 0.058`.
- **Text labels:** left-aligned.
- **Errors:** the error code in red (`#NAME?`, `#VALUE!`, `#CIRC!`, `#ERROR!`, `#NUM!`, `#DIV/0!`), with the reason in a tooltip. A cell that depends on an error cell shows the same code.
- **Recalculation:** the whole model is recalculated after every commit, and after New, Load or loading the test model.
  - It uses a fixed seed and a fixed batch: 100,000 samples on the GPU, or 10,000 on the CPU when WebGPU isn't available.
  - The status appears at the right of the formula bar.
  - Continuous sampling with settling (§6.3) replaces this later.

**In the grid cell:** an uncertain cell must read clearly at a glance, while the grid still looks like a spreadsheet.

- **Text:** the cell shows **mean ± 1 standard deviation**, for example `1,240 ± 85`.
  - Uses the cell's number format.
  - **Centred** in the cell, which sits naturally over the histogram behind it.
  - **When the column is too narrow**, the text is truncated on the **right**, so the mean always stays visible:
    - Wide enough: `1,240 ± 85`, centred
    - Narrower: the text is left-aligned and cut off at the right edge, for example `1,240 ± 8…` or `1,240 …`
    - Too narrow even for the mean: `###`, as in Excel, with the full value in a tooltip **(proposed)**
  - Truncation is shown with an ellipsis (`…`) so it's clear something is hidden **(proposed)**.
- **Background:** a **faint histogram** of the cell's current distribution fills the cell behind the text.
  - It uses the cell's full width and height, with its own horizontal scale fitted to the cell's sample range.
  - Low contrast and muted colour, so the text stays readable. Must work in both light and dark themes.
  - The histogram redraws live as samples build up, throttled to the UI update rate (§6.4).
  - About 20–40 bins, drawn as filled bars or a smoothed area.
- **Telling cell types apart:**
  - Deterministic cells have no histogram, so uncertain cells stand out immediately.
  - Cells that hold a distribution directly and cells that are *calculated* from one could get a subtle visual difference, such as a corner marker **(proposed)**.
- **Rendering:**
  - Histograms are drawn as small inline SVGs through the grid library's custom cell templates (§9).
  - Only visible cells are drawn (virtualised rendering, §10), so hundreds of live histograms stay cheap.
- **Configurable later:**
  - Choice of summary text: mean ± SD, median, P10–P90, or mean only.
  - Background style: histogram, density curve, box plot, or none.
  - How many standard deviations to show.
  - Settings apply to the whole workbook, with per-cell overrides.

**In a detail panel for the selected cell:**

- Histogram, and cumulative distribution (S-curve)
- Summary statistics: mean, median, standard deviation, min and max
- Percentiles: P5, P10, P50, P90, P95, and a user-defined percentile
- Probability that the result is above or below a threshold, for example "chance that profit < 0"
- Sensitivity / tornado chart showing which *uncertain inputs* drive the output most. It's calculated from the live samples using rank correlation, so it needs no extra runs **(proposed)**. For testing deliberate changes to an input, see §7.5.

All of these update live as samples build up.

### 6.6 GPU backend (WebGPU)

**Goal:** make Monte Carlo lightning fast by compiling the **entire workbook into a single WebGPU compute kernel**. Each GPU thread runs one complete iteration of the model. A modern GPU can run tens of thousands of threads in parallel, so it could produce millions of samples per second instead of thousands.

This is a **priority**. A **GPU prototype** should be built early, before the CPU engine's design is locked in, so that the engine's intermediate representation (IR) is shaped to compile well to the GPU.

#### How it would work

1. **Compile to WGSL (the WebGPU shading language):**
   - The dependency graph is already in topological order (§4.3).
   - The uncertain part of the graph is compiled into one WGSL compute shader that computes each cell in turn.
   - Each cell becomes a local variable in the shader.
   - Formulas become WGSL expressions.
   - Distribution functions become calls to sampler functions written in WGSL.
2. **The whole model runs on the GPU, deterministic cells included.**
   - Cells that don't depend on any distribution are evaluated in the kernel in every iteration, just like uncertain cells. They are *not* precomputed on the CPU and passed in as constants.
   - This keeps the two backends structurally identical: the CPU evaluator and the GPU kernel run exactly the same IR. So:
     - every cell can be cross-checked (§6.7);
     - a divergence always points at the backend itself, never at a split between CPU-computed and GPU-computed parts;
     - performance comparisons between the backends are like for like.
   - The cost is negligible, because spreadsheet models are expected to stay far smaller than what a GPU can handle.
3. **Random numbers:**
   - Uses a **counter-based random number generator**, keyed by (seed, iteration index, stream, k).
     - The stream is the distribution call site, so two distributions in one cell draw independently.
     - k picks one of several draws for a single sample, for example the two uniforms Box–Muller needs.
   - **Implemented:** a chain of 32-bit `lowbias32` integer hashes (`packages/engine/src/random.ts`, mirrored in `packages/gpu/src/prelude.ts`).
     - It uses only 32-bit integer operations, so TypeScript (`Math.imul`) and WGSL produce identical bits.
     - Uniforms keep 23 bits, so they are exactly representable in `f32`, which makes CPU and GPU uniform draws bit-identical.
   - This needs no shared state between threads.
   - Results are reproducible whatever the number of threads or the order they run in.
4. **Distribution samplers written in WGSL:**
   - uniform: direct
   - normal: Box–Muller
   - lognormal: exp of a normal sample
   - triangular and PERT: inverse CDF, or a Beta sampler
   - discrete: cumulative-weight lookup
5. **Time series and lookup tables:** time-series worksheets and lookup ranges are uploaded as read-only storage buffers. Time-series structured references (§5.3), `INDEX` and `MATCH` become indexed reads or binary searches in the shader.
6. **Output:**
   - Each thread writes the values of the uncertain cells being watched to a storage buffer, laid out as `[cell][iteration]`.
   - **Reductions on the GPU (implemented for moments):**
     - A summary kernel runs 64 iterations per thread. Each thread keeps, per output, a running count, mean and M2 (Welford), plus NaN and infinity counts, detected from the float's bits.
     - A merge kernel then combines every thread's partials per output, using Chan's parallel formula and a tree reduction in workgroup memory.
     - Only outputs × 5 floats are read back per batch, of up to 4,194,304 iterations. The next batch is queued before the current one is read, so the GPU stays busy.
     - The host merges batches in f64.
     - Raw samples are read back only for the first 262,144 iterations, which feed the histograms and the CPU–GPU comparison.
     - **Measured:** 10,000,000 iterations of a 70-output model in about 0.6 s, against about 17 s when every sample was read back.
     - Histograms and percentiles on the GPU are later steps.
7. **Recompile only on structural edits (implemented):**
   - Constants are read from a storage buffer (`consts`), not written into the WGSL.
   - Compiled pipelines are cached by their shader source (the 16 most recent).
   - Editing a value, such as an input or a distribution parameter written as a number, reuses the compiled pipelines. Measured: about 15–100 ms per batch, against 0.8 s + 2.8 s to recompile.
   - Only formula edits compile a new pipeline, and meanwhile the CPU's results are shown.

#### Known constraints to investigate

- **Precision: `f32` on the GPU is accepted.**
  - WGSL has no general `f64`; GPU arithmetic is `f32`, about 7 significant digits.
  - The formulas typical of fumoca models are expected to cope at 32 bits, because Monte Carlo sampling noise is usually far larger than `f32` rounding error.
  - **No per-cell precision:** there is no per-cell or mixed-precision mode. The GPU backend evaluates the whole model in `f32`.
  - **Choosing `f64`:** a user who wants 64-bit precision **turns off GPU acceleration** in settings, and the CPU worker pool, which always uses `f64`, takes over.
  - **Error in the statistics:** GPU reduction passes (sums, moments) should still use error-reducing techniques such as Kahan or pairwise summation. That way `f32` accumulation error over millions of samples doesn't distort the statistics.
  - **Measured later:** the `f32` vs `f64` difference is to be measured (see GPU prototype deliverables) to confirm this assumption. It isn't a blocker.
  - **Future `f64`:** if WebGPU gains 64-bit float support, adopt it as an option.
- **Unsupported cell contents:**
  - Text, dates-as-text, and functions that return strings or arrays can't run on the GPU directly.
  - Proposal: split the graph. Only the numeric, uncertain part runs on the GPU, and anything the GPU can't handle falls back to CPU workers.
- **Control flow:** `IF` and similar functions can be done with `select()` or with branches. Branches that differ between threads cost performance but remain correct.
- **Kernel size:** very large workbooks may hit shader-size, register or compile-time limits. The kernel may need to be split into several passes, with intermediate cell values kept in storage buffers.
- **Availability:**
  - WebGPU isn't available in every browser and device.
  - The **CPU worker pool (§6.4) stays as the reference implementation and fallback**.
  - Both backends run side by side and are continuously cross-checked (§6.7).
- **Compile time:** shader compile times must stay short enough that editing still feels instant.

#### GPU prototype deliverables

- A proof of concept that compiles a small workbook to WGSL. The workbook covers arithmetic, cross-worksheet references, `IF`, `NORMAL`, `UNIFORM`, `LOGNORMAL`, and a time-series lookup.
- A benchmark comparing samples per second on the GPU with the CPU worker pool, on a model of about 100 cells and one of about 1,000 cells.
- A precision report comparing `f32` GPU results with `f64` CPU results.
- A first version of the CPU/GPU cross-check (§6.7) on the proof-of-concept workbook.

### 6.7 Dual backends: CPU and GPU run side by side

By default, **the CPU and GPU backends both run all the time, in parallel**, on the same model. The aim is to **uncover bugs in either one**. The two are independent implementations, a TypeScript evaluator and a generated WGSL kernel, so any disagreement beyond expected `f32` rounding points to a bug in one of them.

- **Two answers per cell:**
  - Every uncertain cell keeps **two** sets of retained values: one from the CPU (`f64`) and one from the GPU (`f32`).
  - Each set has its own statistics and its own settling state (§6.3).
- **Config menu (implemented):**
  - "CPU iterations" (default 10,000) and "GPU iterations" (default 100,000), each from 0 to 1,000,000,000 (runs go in batches, so memory no longer limits the total). 0 disables that engine, and at least one must run.
  - The settings are saved per browser.
  - With both running, the GPU's results are shown. Both use the same seed, and the CPU's samples are compared with the first `min(cpu, gpu)` GPU iterations.
  - The status reads `GPU 100,000 + CPU 10,000 · agree`, or lists the cells that differ.
  - Without WebGPU, the GPU field is disabled and the CPU always runs.
- **User control:** either backend can be switched off in settings.
  - **GPU off:** CPU only, pure `f64` (§6.6 precision).
  - **CPU off:** GPU only, maximum speed. No cross-check is possible.
  - When WebGPU isn't available, the app runs CPU only and shows a small notice.
- **Which answer the grid shows:**
  - With both on, the grid shows the **GPU** answer, because it has far more samples.
  - **(Proposed)** A setting can switch the display to the CPU answer.
  - The detail panel (§6.5) always shows both, side by side.
- **Same random numbers on both:**
  - Both backends implement the **same counter-based random number generator** (§6.6), keyed by (seed, iteration index, cell id).
  - The generator is implemented bit-identically in TypeScript and WGSL, as are the samplers built on it, apart from `f32` rounding.
  - So iteration *i* on the CPU and iteration *i* on the GPU draw the **same inputs** and should give the **same outputs**, up to rounding.
  - This lets the two be compared **iteration by iteration**, a much sharper test than comparing two independent statistical estimates.
- **Sharing iterations:**
  - The GPU covers a large range of iteration indices.
  - The CPU, which is much slower, covers a **subset** of the same indices, for example every *k*-th index, or the first *N*.
  - The cross-check uses the indices that both have computed.
- **Divergence check (per cell):**
  1. **Per iteration:** relative difference `|cpu − gpu| / max(|cpu|, scale)` must be within an `f32`-appropriate tolerance.
     - A small fraction of mismatches is allowed, because rounding can flip a comparison right on an `IF` threshold and send one iteration down a different branch.
     - The allowed fraction is configurable **(proposed)**.
  2. **Summary statistics:** mean, SD, P5 and P95 from each backend must agree within tolerance. This is a backstop for bugs that the per-iteration check can't see, for example in reductions or aggregation code.
- **Warning:**
  - When a cell diverges beyond tolerance, a small **warning marker** appears in a corner of that cell, like Excel's error triangle but in a warning colour.
  - Hovering shows both answers, the size of the divergence, and a sample iteration where they differ, with its input values, to help reproduce the bug.
  - A workbook-level indicator (for example in the status bar) counts diverging cells and links to a list of them.
  - Divergence reports can be copied as a bug report, with the formulas involved, the seed and the diverging iteration indices **(proposed)**.
  - The marker must not clash with the proposed corner marker for distribution-input cells (§6.5). They use different corners or shapes.
- **Cost:**
  - The CPU cross-check uses the worker pool (§6.4), which the user already controls.
  - Turning the CPU off frees those cores when maximum speed matters more than checking.

---

## 7. Scenario mode

### 7.1 Concept

A **scenario** answers "what if?" questions across combinations of choices. The user picks:

- **Inputs:** cells on any worksheets whose contents the scenario replaces. These can be constants, formulas or distributions, and time-series entries are included. Inputs are organised into **dimensions** (§7.2). Each dimension has a list of **alternatives**.
- **Output cells:** any cells, on any worksheets, whose results the user wants to compare.

The scenario runs every combination of alternatives across dimensions: the **Cartesian product**. For each combination, it records the results of every output cell.

**Example: simple dimensions**
- `Cell1` has alternatives `[1, 2]`.
- `Cell2` has alternatives `[1, 2, 3]`.
- That gives 2 × 3 = **6 combinations**, and each output cell gets 6 results.

### 7.2 Defining a scenario

- A workbook can hold any number of **named scenarios**. They are saved with the workbook.
- **Choosing cells:** the user picks input and output cells by clicking them in the grid, or by typing references such as `Sheet2!B4`.
- **The workbook itself is never changed.** Scenario alternatives override input cells only while the scenario is being evaluated.

#### Dimensions

A scenario is made of one or more **dimensions**. Each dimension contributes one factor to the number of combinations. There are two kinds of dimension:

1. **Single-cell dimension:** one input cell with a list of alternatives, as in the example above.
2. **Group dimension:** several input cells that **change together**.
   - Each alternative of the group is a named **variant**, such as "Aggressive expansion" or "Cautious", which gives a new value or formula to *every* cell in the group at once.
   - The group counts as **one** dimension. A group with 2 variants multiplies the number of combinations by 2, however many cells it contains.
   - This lets a user hand-craft elaborate, internally consistent scenarios that change many cells at once. Price, volume, marketing spend and hiring formulas can all move together, and are never crossed into nonsensical mixes.

**Example: a group dimension combined with a single-cell dimension**

| Dimension | Alternatives |
|---|---|
| `Strategy` (group of 4 cells) | **Aggressive**: `Price = 9.99`, `Volume = =Base!C4 * 1.5`, `Marketing = =NORMAL(50000, 5000)`, `Hires = 12` · **Cautious**: `Price = 12.99`, `Volume = =Base!C4`, `Marketing = 20000`, `Hires = 3` |
| `InterestRate` (single cell) | `0.03`, `0.05`, `0.07` |

That gives 2 × 3 = **6 combinations**.

- A cell can belong to at most one dimension within a scenario.
- In a group, a variant may leave a cell unchanged. That cell then keeps its workbook contents for that variant.

#### Alternatives and overrides

- **What an alternative can be:** anything a cell accepts:
  - a constant, for example `0.05`
  - a formula, for example `=Base!C3 * 1.1`
  - a distribution, for example `=NORMAL(100, 10)`
- **Overriding formula cells:**
  - Input cells can themselves be formula cells. Overriding one replaces its formula for that combination, and cuts it off from the cells it normally depends on.
  - The replacement formula can depend on other cells, as usual.
  - An override that would create a circular reference is reported as an error for the combinations affected, and doesn't stop the whole scenario.
- **Overridden cells are marked:** while a scenario is being viewed or edited, overridden cells are highlighted in the grid, and hovering shows the workbook formula next to the scenario formula **(proposed)**.
- **Entering alternatives (proposed):** a single-cell alternative list can be typed as a plain list, or generated as a range, for example "from 0.02 to 0.08, step 0.01".
- **Labels:** every alternative and variant can have a label, such as "Low", "Base", "High" or "Aggressive", which is used in the results. Labels are optional for single-cell alternatives and required for group variants.

### 7.3 Evaluation

#### The main grid is the Baseline scenario

- There is no separate "main grid simulation" competing with scenarios. **The main grid is itself a scenario: the Baseline**, the combination with no overrides.
- **One scheduler:** the engine runs a single scheduler over a set of **combinations**.
  - With no scenario active, that set is just the Baseline.
  - When a scenario is active, the set is the Baseline **plus** all the scenario's combinations.
  - All compute (the worker pool §6.4, and the GPU §6.6) is shared across the set. A scenario run takes *all* the compute; the Baseline is simply one of its combinations.
- **Settling per combination:** settling (§6.3) is tracked per (combination, group of connected cells). Combinations that have settled stop taking compute, so the remaining compute goes to the ones that are still sampling.
- **What the grid shows:**
  - By default the grid shows the Baseline.
  - **(Proposed)** The user can pick any combination of the active scenario to **view in the grid**. Every cell then shows its distribution for that combination, and overridden cells are highlighted (§7.2).
- **One active scenario at a time (proposed):**
  - Only one scenario runs at a time.
  - The results of scenarios that aren't active are kept until an edit resets them.
- **Edits:** editing a cell resets that cell and its dependents in **every** combination (§6.3). Editing a scenario's alternative resets only the combinations that use it.
- **Sensitivity analyses (§7.5)** work the same way: their base case *is* the Baseline.

- **Each combination is a full Monte Carlo simulation.** Output cells produce a *distribution* for each combination, not a single number. Any other distribution cells in the workbook keep being sampled as usual.
- **Common random numbers (proposed):**
  - Every combination uses the same random stream: the same seed and the same iteration index give the same draws for all the other distribution cells.
  - Differences between combinations then come from the inputs, not from sampling noise. This makes comparisons much sharper.
- **Sample budget:** a set number of samples per combination, for example 10,000. The user can change it.
- **Running live:** like the main grid, results fill in live, combinations are shared across the worker pool (§6.4), and each combination's summary updates as its samples build up.
- **GPU:**
  - The combination index becomes one more dimension of the kernel launch, so each thread handles one (combination, iteration) pair.
  - Constant alternative values are passed in a small buffer, so they need no shader recompilation (§6.6).
  - Formula and distribution overrides are compiled into the kernel as variants. Each overridden cell becomes a branch (or `select`) on its dimension's alternative index, so one kernel covers every combination.
- **Too many combinations:**
  - The UI shows the total number of combinations and the estimated work *before* running, and warns above a threshold (for example 1,000 combinations).
  - Random or Latin hypercube sampling of the combinations may be offered later for very large scenarios **(proposed)**.

### 7.4 Results

- **Results table:**
  - One row per combination. There is a column for each dimension, showing the alternative's label or value, and a column for each output cell.
  - Output values use the same display as uncertain grid cells (§6.5): mean ± SD with a faint histogram behind.
  - Rows can be sorted and filtered by any input or output. For example, sort by P10 of profit, or show only rows where `Strategy = Aggressive`.
- **Comparison charts:**
  - One output's distributions overlaid or placed side by side across combinations, as box plots or ridgelines.
  - A plot of one output against one dimension, with the other dimensions held at a chosen alternative.
  - A heat map of an output statistic, when exactly two dimensions vary.
- **Selecting a row:** opens the full detail panel (§6.5) for that combination's outputs.
- **Applying a combination (proposed):** writes that combination's alternatives into the input cells, with undo.
- **Export:** results can be exported to CSV.

### 7.4.1 Current implementation

**Where scenarios live**
- The left-hand side panel has tabs down its left edge: **Sheets** (with *New sheet* and *New series sheet* buttons above the list) and **Scenarios** (with a *New scenario* button above the list, and a menu per scenario to delete it). More tabs can join later. *Model → New scenario* does the same.
- **A scenario is a dockable window, like a sheet.** It opens beside the sheets, so their cells can be clicked while it's defined.
- Scenarios are saved in the workbook file. Cells are referred to by sheet name, since sheet ids are regenerated on load. Older files load with no scenarios.

**The scenario window**
- **The definition runs down the left:**
  - the scenario's name;
  - its dimensions;
  - its outputs;
  - the combination count (for example "3 × 2 = 6 combinations, plus the Baseline", in orange above 1,000);
  - the samples per combination (10,000 by default);
  - *Run scenario* / *Stop*, with progress.

  The definition can be hidden, so the results take the whole window.
- **A single-cell dimension** has:
  - a cell;
  - the cell's current contents, shown as the Baseline;
  - a list of alternatives, each an optional label and a value, formula or distribution.
- **A group dimension** has a name, and a small table of cells (rows) × named variants (columns). A blank entry leaves that cell unchanged in that variant.
- **Picking cells:** a cell field accepts a typed reference with its sheet (`Sheet1!B3`, `'Option pricing'!B4`) or a cell's name. While it has focus, clicking a cell in any open sheet fills it in, using point mode (§6.1). A named cell is shown by its name, here and in the results. A cell used by two dimensions is flagged.
- **One editor everywhere:** cell fields, alternatives and group variants are edited with the same formula editor as the formula bar (`FormulaField`, built on `FormulaInput`):
  - references and names are coloured, and their cells outlined while a field has focus;
  - alternatives take formulas relative to the overridden cell's sheet, so clicking a cell inserts its address or name there.

**Running**
- *Run scenario* runs the Baseline, then each combination in turn, each for the set number of samples.
  - It uses one engine: the GPU when it's available and enabled, otherwise the CPU worker pool.
  - Only the output cells are evaluated.
  - A combination is the workbook with its alternatives written over the input cells. The workbook itself never changes.
- **Common random numbers:** a distribution's random stream is named by its cell (the sheet name and address) and its position in the formula, not by compile order. Cells a combination doesn't override draw exactly the same numbers in every combination.
- **The grid waits:** a running scenario takes the engine, and the grid's recalculation waits until it finishes or is stopped. The status reads "Running a scenario…".
- Results arrive live, combination by combination. If the model or the scenario changes after a run, the results stay and are marked as out of date until it runs again.

**Results: a pivot of distributions**
- **Fields:** each dimension that ran, plus **Output**.
- **Zones:** each field sits in **Rows**, **Columns** or **Filters**. Fields are dragged between zones, or moved with each field's menu.
- **Filters:** a filter shows one alternative, or **All (pooled)**, which merges every alternative's results into a mixture. Counts, means and variances merge exactly; histograms are re-binned onto their common range. The Output filter can't be pooled.
- **Default layout:**
  - the first dimension on the rows;
  - the second on the columns;
  - further dimensions as filters at their first alternative;
  - Output on the columns when there's one output (or one dimension), otherwise as a filter.
- **Each cell** shows mean ± SD over a faint histogram, like an uncertain grid cell.
- **Clicking a cell** opens its detail: a larger histogram, the mean, SD, P10/P50/P90 (from the histogram) and the sample count.
- **Sorting:** each column sorts the rows, ascending then descending. With every dimension on the rows, the pivot is the flat one-row-per-combination table.
- **Compare with Baseline** shows each cell's change from the Baseline, absolute and as a percentage, shaded green for up and red for down.
- The Baseline's outputs are listed above the table.
- **Not yet built:** comparison charts, CSV export, viewing a combination in the grid, applying a combination, settling per combination, and running all combinations in one GPU kernel.

### 7.5 Sensitivity analysis

Sensitivity analysis is a **special kind of scenario** that answers questions like:

> "How sensitive are revenue and profit to a 10% change in price?"

Under the hood it is an ordinary scenario (§7.1–7.4), so it reuses the same engine, results table and export. What makes it different is how the combinations are generated and how the results are presented.

#### Defining a sensitivity analysis

- **Inputs:** one or more input cells, for example `Price`, `Volume`, `UnitCost`.
- **Outputs:** one or more output cells, for example `Revenue`, `Profit`.
- **Changes to test:**
  - The user always chooses the change explicitly when setting up an analysis. The field is **pre-filled with ±1%**, which tests −1%, base and +1%.
  - Usually given as a **percentage**, for example ±10%, which tests −10%, base and +10%.
  - Can be a list of steps, for example −20%, −10%, 0, +10%, +20%.
  - Can be absolute amounts instead of percentages **(proposed)**.
- **What gets changed in a distribution cell:** the whole distribution is shifted or scaled, for example by multiplying every sample by 1.10. Changing a single distribution parameter (such as only the mean, or only the SD) is available as an advanced option **(proposed)**.

#### How combinations are generated

- **Default: one input at a time.**
  - Each input is changed on its own while every other input stays at its base value.
  - This produces (inputs × steps) + 1 combinations, *not* the full Cartesian product. With 5 inputs and ±10%, that's 11 combinations instead of 243.
- **Optional: two inputs at a time.** Pairs of inputs are changed together to reveal interactions, and are shown as a heat map.
- **Accuracy:** common random numbers (§7.3) are especially important here. Without them, sampling noise can swamp small changes in the output.

#### Results

- **Sensitivity table:**
  - One row per (input, output) pair.
  - Shows how much the output changes, in absolute terms and as a percentage, for each step.
  - Includes the **elasticity**: the percentage change in the output divided by the percentage change in the input. For example, "a 1% rise in price gives a 2.4% rise in profit".
  - Changes can be measured on the mean (default) or on another statistic, such as P10, P90, or the chance that profit is below 0.
- **Tornado chart:** for each output, inputs are ranked by how much they move it, with the low and high step shown as bars either side of the base value.
- **Spider chart:** output against the percentage change in each input, one line per input. It shows non-linear effects.
- **Plain-language summary (proposed):** for example, "Profit is most sensitive to Price (±10% → ±24%), then UnitCost (±10% → ∓15%)."

#### Relationship to the live sensitivity in §6.5

The two are complementary:

- **§6.5 (the tornado in the detail panel):** comes for free from the samples the engine is already generating. It uses rank correlation or regression between the sampled inputs and each output, and answers "which *uncertainties* drive this output?"
- **§7.5 (this section):** tests specific changes chosen by the user, and answers "what happens if price moves by *x*%?"

---

## 8. Distribution, storage and collaboration

### 8.1 Distribution

- fumoca is **free, open-source software** **dual-licensed under MIT or Apache-2.0, at the user's option**, the same arrangement as the Rust project. Contributions are dual-licensed the same way unless stated otherwise. See the Licence section of the README, `LICENSE-MIT` and `LICENSE-APACHE`.
  - A permissive licence lets the closed-source cloud provider (§8.3) plug into the open-source core without any licensing conflict.
  - It also lets anyone use, modify and embed fumoca freely.
- **Third-party dependencies** (grid library, charting library and others) must use licences compatible with this, such as MIT, Apache-2.0 or BSD.
- There are two ways to run it:
  - **Hosted:** at **fumoca.com**.
  - **Self-built:** clone the git repo, build it, and run it locally.
- Both are the same app with the same features. Nothing in the open-source core depends on fumoca.com.

### 8.2 Local storage (open source, always available)

- **Save and load files:**
  - Workbooks are saved to and loaded from files on the user's machine.
  - The file format is versioned JSON, with a `.fumoca` extension **(proposed)**.
  - Where the browser supports the File System Access API, files are saved in place. Other browsers fall back to download and upload.
- **Autosave:** the current workbook is autosaved to the browser's IndexedDB, so a refresh or crash never loses work.
- **Import and export:**
  - Import CSV into a time-series worksheet, for example historical prices.
  - Export simulation and scenario results to CSV.
- **File contents:** a file holds the *model* only. That means cells, worksheets, time-series config, scenarios and settings. It never holds simulation samples, which are always regenerated.

### 8.3 Cloud storage and realtime collaboration (pluggable)

- **Where it comes from:** cloud storage and multi-user collaboration are *not* part of the open-source core. They come from a **separate, closed-source cloud-provider plan**. There, the model is stored in the cloud and **several people can edit it at once, seeing each other's changes in real time**.
- **Cloud-agnostic:**
  - The open-source core defines a **pluggable storage interface**. It never depends on any specific cloud SDK.
  - A provider can be built on any backend. For example, Google Firebase offers key-value storage with realtime subscriptions. Supabase, or a custom server, could work just as well.

#### Storage provider interface (proposed)

Each provider says which **capabilities** it supports, and the UI adapts to them.

| Capability | Operations |
|---|---|
| `documents` (required) | list, open, save, rename, delete workbooks |
| `realtime` | subscribe to remote changes; publish local changes as fine-grained operations |
| `presence` | who else is viewing, and their selected cell or worksheet |
| `auth` | sign in / sign out, current user identity |
| `sharing` | invite users, set permissions (view / edit) |

Built-in providers in the open-source core: **local file** and **browser (IndexedDB)**. Both support `documents` only.

#### Collaboration model (proposed)

- **Sync by operation:**
  - Edits are sent as small **operations**, such as "set cell `Sheet1!B4` to `=NORMAL(100,10)`", "add series", or "rename worksheet".
  - Whole-document saves are not used for this. This keeps realtime sync efficient and conflicts rare.
- **Conflict resolution: last writer wins, per cell.**
  - Each cell (and each series entry) is its own unit. Concurrent edits to *different* cells never conflict.
  - When two users edit the *same* cell, the edit the provider applies last wins. "Last" is decided by the provider's ordering, such as a server timestamp or sequence number, not by client clocks.
  - Edits show up immediately on the editor's own screen. If a remote edit wins, the losing client's cell is updated to the winning value.
  - **(Proposed)** A brief, unobtrusive notice appears when your edit is overwritten by someone else's.
  - **Structural operations:** inserting or deleting rows and columns, adding, renaming or deleting worksheets or series, and changing a time-series frequency all shift references. The provider applies these in a single total order, and every client applies them in that same order. A cell edit that targets a deleted cell is dropped **(proposed)**.
  - Non-cell settings, such as scenario definitions and lookup mapping config, also use last-writer-wins, per setting.
- **Simulation stays local:**
  - Each client runs its own simulation.
  - Only the model is synced, never samples.
  - Collaborators see the same model, and statistically equivalent results.
- **Presence:** collaborators' selections are shown in the grid, as coloured cell outlines with names.

#### Registering providers: at build time

- Storage providers are **registered at build time**. The app never loads provider code at runtime.
- **The open-source build** contains only the built-in providers (local file and IndexedDB). It must build and run fully without any closed-source code.
- **The fumoca.com build** adds the closed-source cloud provider:
  - It's a separate package, from a private repo or registry.
  - It's pulled in by a build-time registration step, for example a build config listing the providers to include **(proposed)**.
- **Provider API:** the open-source repo publishes the storage provider interface as a stable, versioned TypeScript API, and the closed-source provider implements it. Breaking changes to the interface need a major version bump.
- **No hidden code paths:** the open-source core contains no references to, or feature flags for, the closed-source provider. Registration is the only point where they connect.

## 9. Technical architecture

- **Language:** TypeScript only, in strict mode.
- **UI framework:** React 19, with **[Mantine](https://mantine.dev/)** (MIT) as the component library for everything outside the grid: menus, dialogs, forms, panels, tabs and theming (including light/dark).
- **Grid library: [RevoGrid](https://rv-grid.com/)** (MIT), used through its official React wrapper `@revolist/react-datagrid`.
  - It's built for spreadsheets: virtualised, with range selection, autofill (fill handle), clipboard support and in-place editing.
  - It releases frequently and has stable (non-alpha) releases that work with React 19.
  - Cells are drawn through custom **cell templates**, and the in-cell histogram (§6.5) is a small inline SVG behind the text. Only visible cells are rendered, so this stays cheap.
  - It has no formula engine of its own: fumoca provides the formula bar and all calculation.
  - Glide Data Grid was considered first but rejected. Its React 19 support exists only in alpha releases, and there has been no stable release since February 2024.
  - The requirements it was chosen against:
  - Virtualised rendering, smooth with 10,000+ rows and many columns (§10).
  - **Custom cell rendering**, so a faint live histogram can be drawn behind each uncertain cell (§6.5).
  - Spreadsheet-style interaction: cell selection and ranges, keyboard navigation, in-place editing, copy/paste, fill handle.
  - Doesn't need a formula engine of its own. fumoca's engine owns all calculation, and the grid only displays and edits.
  - A permissive licence (MIT/Apache), active maintenance, and stable releases that work with React 19.
- **Tabs and tiling: [dockview](https://dockview.dev/)** (`dockview-react`, MIT).
  - Worksheets open as tabs. Dragging a tab to the edge of another pane tiles the sheets side by side, with resizable splits.
  - Only one model is open at a time. Its sheets can be opened as tabs, closed, and reopened from the Sheets list.
  - Mantine has no docking or split-pane component, which is why a separate library is used.
- **Charting library: [Apache ECharts](https://echarts.apache.org/)** (Apache-2.0), used through a React wrapper. It's canvas-based, handles live updates well, has built-in themes, and covers every chart type needed. The requirements it was chosen against:
  - Histogram, cumulative distribution (S-curve), box plot, tornado, spider/line, and heat map charts (§6.5, §7.4, §7.5).
  - Fast, frequent updates while samples build up live.
  - Works well with React, and supports light and dark themes.
  - Note: the in-cell histograms are drawn by the grid's own cell renderer, not by the charting library.
- **Platform:** browser-based single-page app. No server is needed for core features.
- **Main modules:**
  - `engine/parser`: turns formula text into an AST
  - `engine/graph`: builds the dependency graph, orders recalculation, detects cycles
  - `engine/evaluator`: evaluates formulas for deterministic recalculation and for simulation
  - `engine/functions`: the function library
  - `engine/random`: seeded random number generator and distribution samplers
  - `engine/timeseries`: time axes, frequencies and lookup logic
  - `sim/`: the worker pool running the continuous sampling loop across multiple cores, the coordinator that merges results into each cell's sample buffer, and the aggregation of statistics sent to the UI
  - `gpu/`: compiles the model to WGSL, manages WebGPU devices and buffers, runs GPU reduction kernels (§6.6)
  - `crosscheck/`: compares CPU and GPU results per cell, detects divergence, produces reports (§6.7)
  - `storage/`: the storage provider interface, the built-in local-file and IndexedDB providers, the file format and its version upgrades, and the operation model used for sync (§8)
  - `scenario/`: scenario definitions, generating the combinations, scheduling combinations across the workers and GPU, collecting results (§7)
  - `ui/`: React components for the grid, formula bar, worksheet tabs, charts, scenario editor and results views
- The engine has no dependency on the UI, so it can be unit-tested on its own.
- **Shared IR:** both the CPU evaluator and the GPU compiler work from the same compiled intermediate representation (IR) of the model: a flat, topologically ordered list of typed operations. Simulation backends are interchangeable behind a common interface.

### 9.1 Build process and tooling

| Area | Tool |
|---|---|
| Package manager | **pnpm**, with workspaces. The version is pinned through `packageManager` in `package.json`, via Corepack |
| Runtime | **Node.js** LTS, pinned in `.nvmrc` |
| Bundler / dev server | **Vite**, with `@vitejs/plugin-react` |
| Type checking | **TypeScript** (strict), run as `tsc --noEmit` per package. Vite strips types without checking them |
| Unit tests | **Vitest**, configured once at the root with a project for each package |
| Property-based tests | **fast-check**, for the parser and date/granularity arithmetic |
| Browser / GPU tests | **Playwright** (Chromium with WebGPU), for the GPU kernels, the CPU/GPU cross-check (§6.7) and end-to-end UI tests |
| Lint + format | **Biome** |
| CI | **GitHub Actions**: typecheck → lint → unit tests → build → browser tests |
| Hosting | Static files. No special headers are needed, because `SharedArrayBuffer` isn't used (§6.4) |

**Workspace layout:**

```
packages/
  engine/   pure TS: parser, graph, evaluator, functions, random, timeseries. No DOM, no React
  sim/      worker pool, scheduler, settling
  gpu/      WGSL compiler and WebGPU runtime
  storage/  storage provider interface; local-file and IndexedDB providers
  app/      React + Mantine UI (RevoGrid, ECharts); createApp({ providers })
```

- **Enforced boundaries:**
  - `engine` is compiled with no DOM type library, so any accidental use of browser APIs fails type checking.
  - Dependencies only point downwards: `app` → `sim` / `gpu` / `storage` → `engine`.
- **Source packages:** workspace packages export their TypeScript source directly. Vite and Vitest compile it, so there is no per-package build step.
- **Build-time providers (§8.3):**
  - The open-source `app` build passes only the built-in storage providers to `createApp`.
  - The fumoca.com build lives in a separate private repo. It depends on these packages and passes in the closed-source cloud provider.
- **Web Workers** are created with `new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })`, which Vite bundles natively.
- **WGSL shaders** are imported as text with Vite's `?raw` suffix.
- **Test strategy:**
  - Excel conformance fixtures: formula → expected result, checked against real Excel output.
  - Statistical tests of the distribution samplers, with fixed seeds.
  - Tests that the random number generator gives bit-identical output in TypeScript and WGSL (§6.7).

---

## 10. Performance targets (proposed)

- **CPU backend:** 10,000 iterations of a model with about 1,000 formula cells finishes in a few seconds on a typical laptop.
- **GPU backend (stretch goal):** at least 1,000,000 iterations per second on a model with about 1,000 cells, on a mid-range GPU. To be confirmed by the GPU prototype (§6.6).
- The grid renders only the visible cells (virtualised rendering) and scrolls smoothly with at least 10,000 rows.

