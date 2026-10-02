"""
Generates fumoca's Tesla 2029 model from ARK Invest's valuation model.

Source: "Tesla 2029 Valuation Extract for Github.xlsx" from
https://github.com/ARKInvest/ARK-Invest-Tesla-Valuation-Model (ARK Investment Management LLC).

The model's logic is ARK's, restructured for fumoca:
- ARK's "Monte Carlo Single Simulation" sheet is split into one sheet per business line (EV,
  Capital, Insurance, Ride-hail, Storage, Optimus, Valuation), keeping ARK's rows, years across.
- Inputs are named cells. Each draws from a normal distribution clamped to [min, max], written as
  one short formula in place of ARK's nested NORM.INV(RAND()) formula and helper columns.
- The robotaxi launch year and the production constraint are correlated through two visible
  standard-normal cells, as in SPECS.md §6.2.1.
- "Valuation ASP Tables" becomes "Price tables", keeping only the tables the model uses.
- NUMBERVALUE(LEFT(year, 4)) becomes INT(year): fumoca has no text functions yet.
- The robotaxi launch is a month (RobotaxiLaunch, a period), in place of ARK's fractional year
  (2026.44). ARK's formulas on the launch year are rewritten in terms of LaunchYear =
  YEAR(RobotaxiLaunch) and LaunchFraction = (MONTH(RobotaxiLaunch) − 1)/12. That also keeps the
  arithmetic small, which single precision (the GPU) needs near 2026.
- ARK's hard-coded history (2019–2024) moves to a yearly series sheet, "Actuals", one named
  column per line, and the model looks it up: =Actuals[Cars sold]@B$1.

It also writes ARK's saved run (its draws and every model value) as a snapshot, which the tests
use to check that the restructured model computes exactly what ARK's does.

Usage: python scripts/ark-tesla/generate.py <path to the .xlsx>
Writes packages/app/src/tesla/arkTesla.generated.ts. Standard library only.
"""

import html
import json
import re
import sys
import zipfile
from pathlib import Path

OUT = Path(__file__).resolve().parents[2] / "packages/app/src/tesla/arkTesla.generated.ts"

# ARK's sheets, by file.
INPUTS, ASP, MODEL = 3, 4, 6
INPUTS_SHEET, ASP_SHEET, MODEL_SHEET = (
    "Tesla Valuation Inputs",
    "Valuation ASP Tables",
    "Monte Carlo Single Simulation",
)

# Names for ARK's inputs, by their row on ARK's inputs sheet.
INPUT_NAMES = {
    12: "AutonomousEbitdaMargin",
    13: "MaxProductionIncrease",
    14: "MilesPerRobotaxi",
    15: "RobotaxiLaunchYear",  # drawn as RobotaxiLaunchDelay: see launch_delay
    16: "TakeoverTime",
    18: "DebtFundedShare",
    19: "VehicleCapitalEfficiency",
    20: "EquityRaiseMarketCap",
    21: "EquityRaiseCapex",
    22: "EquityRaiseIncentives",
    23: "BitcoinShare",
    24: "BitcoinAppreciation",
    26: "MaxGrossMargin",
    27: "LearningRate",
    28: "FactoryUtilization",
    29: "SegmentPenetration",
    30: "TaxRate",
    31: "InterestRate",
    33: "InsuredShare",
    34: "InsuranceCommission",
    35: "PremiumPerMile",
    36: "RideHailPremiumAddition",
    37: "BeginningLossRatio",
    38: "AnnualSafetyGain",
    39: "MilesPerPersonalCar",
    41: "RideHailMilesPerCar",
    42: "HumanRideHailCut",
    43: "HumanRideHailMaxShare",
    44: "HumanRideHailMaxMiles",
    46: "ChinaPlatformCut",
    47: "ChinaFleetShare",
    48: "PartnerCutPerMile",
    49: "YearsWithoutPartner",
    51: "StorageCapitalEfficiency",
    52: "MaxStorageIncrease",
    53: "StorageGrossMargin",
    55: "LaborHoursPerCar",
    56: "OptimusUtility",
    57: "OptimusLaborShare",
    59: "SgaShare",
    60: "RndShare",
    61: "EvMultiple",
    62: "InsuranceMultiple",
    63: "RobotaxiMultiple",
    64: "StorageMultiple",
}

# ARK's model rows 65–201, split into sheets: (name, first row, last row). Each sheet's row 1
# holds the years (ARK's section header row), and ARK's row r goes to row r − first + 1.
SECTIONS = [
    ("EV", 65, 87),
    ("Capital", 88, 104),
    ("Insurance", 105, 121),
    ("Ride-hail", 122, 155),
    ("Storage", 156, 163),
    ("Optimus", 164, 175),
    ("Valuation", 176, 201),
]
# Sheets whose first ARK row isn't a header with the years get one added above.
HEADERLESS = {"Capital"}

# ARK's hard-coded history (2019–2024), by model row: the series column each goes to on the
# "Actuals" sheet. Values written as arithmetic, such as (27236-1580)*10^6, keep it.
ACTUALS = {
    66: "Cars produced",
    67: "Cars sold",
    69: "Cumulative cars sold",
    73: "EV revenue",
    77: "Capex per vehicle",
    80: "EV gross profit",
    81: "SG&A",
    82: "SG&A share",
    83: "R&D",
    84: "R&D share",
    88: "Gross PP&E",
    91: "Accumulated depreciation",
    92: "Depreciation",
    93: "Net PP&E",
    95: "Depreciation rate",
    97: "Working capital",
    98: "Long-term debt",
    100: "Cash",
    103: "Bitcoin value",
    106: "Insured share",
    157: "Storage deployed (MWh)",
    158: "Storage revenue per kWh",
    161: "Storage gross profit",
    163: "Storage capex per MWh",
    165: "Labor hours per car",
    177: "Total revenue",
    178: "Total EBIT",
    179: "Total EBITDA",
    181: "Interest paid",
    185: "Total gross margin",
    196: "Enterprise value",
    197: "Market cap",
    198: "Shares outstanding",
    199: "Stock price",
}
ACTUAL_YEARS = "BCDEFG"  # 2019–2024

# ARK's valuation dates (O203, O204) move to the Valuation sheet.
DATES = {"O203": ("Valuation", "B29"), "O204": ("Valuation", "B30")}

# Output names, by ARK model address.
OUTPUT_NAMES = {
    "L177": "Revenue2029",
    "L179": "Ebitda2029",
    "L191": "InsuranceValue",
    "L192": "ElectricVehicleValue",
    "L193": "RobotaxiValue",
    "L194": "HumanRideHailValue",
    "L195": "StorageValue",
    "L196": "EnterpriseValue",
    "L197": "MarketCap2029",
    "L199": "SharePrice2029",
    "L201": "CAGR",
}

# ----------------------------------------------------------------------------------------------
# Reading the workbook


def col_num(letters):
    n = 0
    for ch in letters:
        n = n * 26 + ord(ch) - 64
    return n


def col_letters(n):
    s = ""
    while n > 0:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


REF = re.compile(r"(?<![A-Za-z_.])(\$?)([A-Z]{1,3})(\$?)(\d+)(?![\d(A-Za-z_])")


def shift(formula, dx, dy):
    """Excel's shared formulas: the master formula moved by (dx, dy), as when copied."""

    def rep(m):
        ca, letters, ra, row = m.groups()
        c = col_num(letters) + (0 if ca else dx)
        r = int(row) + (0 if ra else dy)
        return f"{ca}{col_letters(c)}{ra}{r}"

    parts = re.split(r'("[^"]*")', formula)
    return "".join(p if p.startswith('"') else REF.sub(rep, p) for p in parts)


def load(z, strings, n):
    x = z.read(f"xl/worksheets/sheet{n}.xml").decode()
    masters, cells, pending = {}, {}, []
    for c in re.finditer(r'<c r="([A-Z]+)(\d+)"([^>]*?)(?:/>|>(.*?)</c>)', x, re.S):
        col, row, attrs, body = c.groups()
        if not body:
            continue
        addr = f"{col}{row}"
        v = re.search(r"<v>(.*?)</v>", body, re.S)
        val = v.group(1) if v else None
        if val is not None and 't="s"' in attrs:
            val = strings[int(val)]
        elif val is not None and not re.search(r't="(str|b|e)"', attrs):
            val = float(val)
        f = re.search(r"<f([^>]*?)(?:/>|>(.*?)</f>)", body, re.S)
        formula = None
        if f:
            fattrs, ftext = f.groups()
            si = re.search(r'si="(\d+)"', fattrs)
            if ftext:
                formula = html.unescape(ftext)
                if si:
                    masters[si.group(1)] = (col_num(col), int(row), formula)
            elif si:
                pending.append((addr, col_num(col), int(row), si.group(1)))
        cells[addr] = [val, formula]
    for addr, c, r, si in pending:
        mc, mr, mf = masters[si]
        cells[addr][1] = shift(mf, c - mc, r - mr)
    return cells


def split(addr):
    m = re.fullmatch(r"([A-Z]+)(\d+)", addr)
    return m.group(1), int(m.group(2))


def text(value):
    return str(value).replace("�", " ").strip()


# ----------------------------------------------------------------------------------------------
# Where ARK's cells go


def model_target(col, row):
    """ARK model cell → (sheet, column letters, row), or None if it isn't part of the model."""
    if col_num(col) > 12:
        return None
    for name, first, last in SECTIONS:
        if first <= row <= last:
            offset = first - 2 if name in HEADERLESS else first - 1
            return name, col, row - offset
    return None


def asp_target(col, row):
    """ARK price-table cell → (column letters, row) on "Price tables", or None if unused."""
    if 17 <= row <= 37 and col_num(col) <= 7:
        return col, row - 16
    if 40 <= row <= 63 and col in ("D", "E"):
        return col_letters(col_num(col) - 3), row - 17
    return None


def quote(sheet):
    return sheet if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.]*", sheet) else f"'{sheet}'"


TOKEN = re.compile(
    r"(?:(?:'(?P<qs>[^']+)'|(?P<ps>[A-Za-z_][A-Za-z0-9_. ]*?))!)?"
    r"(?P<a1>\$?[A-Z]{1,3}\$?\d+)(?::(?P<a2>\$?[A-Z]{1,3}\$?\d+))?(?![\d(A-Za-z_])"
)


CELL = r"\$?[A-Z]{1,3}\$?\d+"
# ARK's formulas on the launch year, in terms of years after the base year instead.
LAUNCH_REWRITES = [
    (r"RobotaxiLaunchYear-INT\(RobotaxiLaunchYear\)", "LaunchFraction"),
    (r"INT\(RobotaxiLaunchYear\)", "LaunchYear"),
    (rf"RobotaxiLaunchYear-({CELL})", r"(LaunchYear-\1+LaunchFraction)"),
    (rf"({CELL})-RobotaxiLaunchYear", r"(\1-LaunchYear-LaunchFraction)"),
    (rf"RobotaxiLaunchYear>({CELL})", r"(LaunchYear-\1+LaunchFraction>0)"),
]


def launch_delay(formula):
    for pattern, replacement in LAUNCH_REWRITES:
        formula = re.sub(pattern, replacement, formula)
    assert "RobotaxiLaunchYear" not in formula, formula
    return formula


class Translator:
    def __init__(self, model, model_inputs_row):
        self.model = model
        # Which ARK inputs-sheet row each model input row draws from (rows 43 and 44 swap).
        self.model_inputs_row = model_inputs_row

    def corner(self, ref):
        m = re.fullmatch(r"(\$?)([A-Z]{1,3})(\$?)(\d+)", ref)
        return m.group(1), m.group(2), m.group(3), int(m.group(4))

    def place(self, source_sheet, target_sheet, col, row, ca, ra, here):
        """A reference to (target_sheet, col, row) written from `here`'s sheet."""
        prefix = "" if target_sheet == here else f"{quote(target_sheet)}!"
        return f"{prefix}{ca}{col}{ra}{row}"

    def single(self, sheet, ref, here):
        ca, col, ra, row = self.corner(ref)
        if sheet == ASP_SHEET:
            target = asp_target(col, row)
            assert target, f"price-table cell {col}{row} isn't carried over"
            return self.place(sheet, "Price tables", target[0], target[1], ca, ra, here)
        if sheet in (None, MODEL_SHEET):
            if 12 <= row <= 64:
                if col == "L":
                    return INPUT_NAMES[self.model_inputs_row[row]]
                value = self.model.get(f"{col}{row}", [None])[0]
                assert value in (None, ""), f"model input-row cell {col}{row} has a value"
                return "0"
            if row == 10:
                return f"{ca}{col}{ra}1"
            if f"{col}{row}" in DATES:
                target_sheet, address = DATES[f"{col}{row}"]
                c, r = split(address)
                return self.place(sheet, target_sheet, c, r, "$", "$", here)
            # Text can't be calculated with yet. ARK only reaches labels in IF branches that
            # are never taken (Excel's IF is lazy), so they read as 0.
            if isinstance(self.model.get(f"{col}{row}", [None])[0], str):
                return "0"
            target = model_target(col, row)
            assert target, f"model cell {col}{row} isn't carried over"
            return self.place(sheet, target[0], target[1], target[2], ca, ra, here)
        raise AssertionError(f"reference to sheet {sheet}")

    def formula(self, formula, here, default_sheet=None):
        f = formula.replace("_xlfn.", "")
        f = re.sub(r"NUMBERVALUE\(LEFT\(([^,()]+),4\)\)", r"INT(\1)", f)
        assert "NUMBERVALUE" not in f and "LEFT(" not in f, f

        def rep(m):
            sheet = m.group("qs") or m.group("ps") or default_sheet
            first = self.single(sheet, m.group("a1"), here)
            if not m.group("a2"):
                return first
            second = self.single(sheet, m.group("a2"), here)
            # A range keeps one sheet prefix, on its first corner.
            if "!" in second:
                assert first.split("!")[0] == second.split("!")[0], m.group(0)
                second = second.split("!", 1)[1]
            return f"{first}:{second}"

        parts = re.split(r'("[^"]*")', f)
        out = "".join(p if p.startswith('"') else TOKEN.sub(rep, p) for p in parts)
        return "=" + launch_delay(out)


# ----------------------------------------------------------------------------------------------
# Building fumoca's sheets


def build(path):
    z = zipfile.ZipFile(path)
    ss = z.read("xl/sharedStrings.xml").decode()
    strings = [
        html.unescape("".join(re.findall(r"<t[^>]*>(.*?)</t>", si, re.S)))
        for si in re.findall(r"<si>(.*?)</si>", ss, re.S)
    ]
    inputs, asp, model = (load(z, strings, n) for n in (INPUTS, ASP, MODEL))

    # Model input row → inputs-sheet row, read from each draw's formula.
    model_inputs_row = {}
    for row in range(12, 65):
        formula = model.get(f"L{row}", [None, None])[1]
        if formula:
            rows = {int(r) for r in re.findall(rf"'{INPUTS_SHEET}'!\$?[A-Z]+\$?(\d+)", formula)}
            assert len(rows) == 1, (row, rows)
            model_inputs_row[row] = rows.pop()
    t = Translator(model, model_inputs_row)

    sheets = {
        name: {} for name in ["Inputs", "Actuals", "Price tables"] + [s for s, _, _ in SECTIONS]
    }
    actual_columns = list(ACTUALS.values())
    for i, col in enumerate(ACTUAL_YEARS):
        sheets["Actuals"][f"A{i + 1}"] = int(model[f"{col}10"][0])
    names = {name: {} for name in sheets}

    # Inputs: ARK's ranges, and a draw from each. ARK's inputs-sheet row q goes to row q − 6.
    cells = sheets["Inputs"]
    at = lambda col, q: f"{col}{q - 6}"  # noqa: E731
    cells["A1"] = "Tesla 2029: inputs (from ARK Invest's model)"
    cells["A2"] = (
        "Each input is normally distributed: the downside and upside are one standard deviation "
        "below and above the mean, and draws are clamped to the minimum and maximum."
    )
    for col, label in zip("ABCDEFGHIJK", [
        "Input", "Minimum", "Downside", "Upside", "Maximum", "Draw",
        "Correlated z", "Correlation", "Notes (ARK)", "Launch year", "Into the year",
    ]):
        cells[f"{col}4"] = label
    for q in range(11, 65):
        label = inputs.get(f"A{q}", [None])[0]
        if label:
            cells[at("A", q)] = text(label)
        if q not in INPUT_NAMES:
            continue
        for col in "BCDE":
            value, formula = inputs.get(f"{col}{q}", [0.0, None])
            cells[at(col, q)] = f"={formula}" if formula else value
        lo, down, up, hi = (at(c, q) for c in "BCDE")
        mean, sd = f"({down}+{up})/2", f"ABS({up}-{down})/2"
        normal = f"NORMAL({mean}, {sd})"
        if q in (13, 15):
            normal = f"{mean} + {sd}*{at('G', q)}"
        if q == 15:
            # A month: ARK's years (clamped normal) counted in whole months from January 2025.
            years = f"IF({down}={up}, {down}, MAX({lo}, MIN({hi}, {normal})))"
            cells[at("F", q)] = f"=PERIOD.MONTH(2025, 1) + ROUND(12*({years} - 2025), 0)"
            names["Inputs"]["RobotaxiLaunch"] = at("F", q)
            cells[at("J", q)] = f"=YEAR({at('F', q)})"
            names["Inputs"]["LaunchYear"] = at("J", q)
            cells[at("K", q)] = f"=(MONTH({at('F', q)}) - 1)/12"
            names["Inputs"]["LaunchFraction"] = at("K", q)
        else:
            draw = f"IF({down}={up}, {down}, MAX({lo}, MIN({hi}, {normal})))"
            cells[at("F", q)] = f"={draw}"
            names["Inputs"][INPUT_NAMES[q]] = at("F", q)
        model_row = next(r for r, i in model_inputs_row.items() if i == q)
        note = model.get(f"O{model_row}", [None])[0]
        if note:
            cells[at("I", q)] = text(note)
    # The launch year moves with the production constraint (ARK's copula, as two visible cells).
    z1, z2, rho = at("G", 13), at("G", 15), at("H", 15)
    cells[z1] = "=NORMAL(0, 1)"
    cells[rho] = model["X14"][0]
    cells[z2] = f"={rho}*{z1} + SQRT(1 - {rho}^2)*NORMAL(0, 1)"

    # Price tables.
    for addr, (value, formula) in asp.items():
        col, row = split(addr)
        target = asp_target(col, row)
        if not target or value in (None, "") and not formula:
            continue
        out = f"{target[0]}{target[1]}"
        sheets["Price tables"][out] = (
            t.formula(formula, "Price tables", ASP_SHEET) if formula else
            (text(value) if isinstance(value, str) else value)
        )

    # The business lines and valuation, with ARK's notes in column N.
    snapshot = {}
    for addr, (value, formula) in model.items():
        col, row = split(addr)
        if row < 65:
            continue
        if col == "O":
            target = model_target("A", row)
            if target and value not in (None, "") and not formula:
                sheets[target[0]][f"N{target[2]}"] = text(value)
            continue
        target = model_target(col, row)
        if not target:
            continue
        sheet, c, r = target
        out = f"{c}{r}"
        # History moves to Tesla actuals: a number, or arithmetic on numbers only.
        if row in ACTUALS and col in ACTUAL_YEARS and (
            (formula is None and isinstance(value, float))
            or (formula and not re.search(r"[A-Z]+\$?\d", formula))
        ):
            series_col = col_letters(2 + actual_columns.index(ACTUALS[row]))
            series_row = ACTUAL_YEARS.index(col) + 1
            sheets["Actuals"][f"{series_col}{series_row}"] = f"={formula}" if formula else value
            sheets[sheet][out] = f"=Actuals[{ACTUALS[row]}]@{c}$1"
            snapshot[f"{sheet}!{out}"] = value
            continue
        if formula:
            sheets[sheet][out] = t.formula(formula, sheet, MODEL_SHEET)
        elif value not in (None, ""):
            sheets[sheet][out] = text(value) if isinstance(value, str) else value
        if col != "A" and isinstance(value, float):
            snapshot[f"{sheet}!{out}"] = value
    for name in HEADERLESS:
        first = next(f for s, f, _ in SECTIONS if s == name)
        for c in range(2, 13):
            sheets[name][f"{col_letters(c)}1"] = model[f"{col_letters(c)}10"][0]
        sheets[name]["A1"] = name
    for addr, (sheet, out) in DATES.items():
        sheets[sheet][out] = model[addr][0]
    sheets["Valuation"]["A29"] = "Price date (ARK's publication, Excel date)"
    sheets["Valuation"]["A30"] = "Target date (end of 2029)"
    for addr, name in OUTPUT_NAMES.items():
        col, row = split(addr)
        sheet, c, r = model_target(col, row)
        names[sheet][name] = f"{c}{r}"

    draws = {INPUT_NAMES[q]: model[f"L{r}"][0] for r, q in model_inputs_row.items()}
    # ARK's launch, 2026.44, as the year and how far into it: the cells the model reads.
    launch = draws.pop("RobotaxiLaunchYear")
    draws["LaunchYear"] = float(int(launch))
    draws["LaunchFraction"] = launch - int(launch)
    return sheets, names, draws, snapshot


def write(sheets, names, draws, snapshot):
    order = ["Inputs", "EV", "Capital", "Insurance", "Ride-hail", "Storage", "Optimus",
             "Valuation", "Actuals", "Price tables"]
    series = {
        "Actuals": {"granularity": "year", "type": "level", "columns": list(ACTUALS.values())}
    }
    lines = [
        "// Generated by scripts/ark-tesla/generate.py from ARK Invest's Tesla 2029 valuation model",
        "// (https://github.com/ARKInvest/ARK-Invest-Tesla-Valuation-Model). Do not edit by hand.",
        "",
        "/** The model's sheets: cell contents by address, and named cells. */",
        "export const ARK_SHEETS: {",
        "  name: string;",
        "  cells: Record<string, number | string>;",
        "  names: Record<string, string>;",
        "  series?: { granularity: \"year\"; type: \"level\"; columns: string[] };",
        "}[] = " + json.dumps(
            [
                {"name": n, "cells": sheets[n], "names": names[n], **({"series": series[n]} if n in series else {})}
                for n in order
            ],
            indent=2,
            ensure_ascii=False,
        ) + ";",
        "",
        "/** ARK's saved run: the value each input drew. */",
        "export const ARK_DRAWS: Record<string, number> = " + json.dumps(draws, indent=2) + ";",
        "",
        "/** ARK's saved run: every model value, by sheet and address. */",
        "export const ARK_VALUES: Record<string, number> = " + json.dumps(snapshot, indent=2) + ";",
        "",
    ]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("\n".join(lines), encoding="utf-8")
    print(f"Wrote {OUT}: {sum(len(s) for s in sheets.values())} cells, {len(snapshot)} values")


if __name__ == "__main__":
    write(*build(sys.argv[1]))
