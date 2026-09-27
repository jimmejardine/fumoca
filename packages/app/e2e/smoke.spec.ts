import { readFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";

const tabs = (page: Page) => page.locator(".dv-tab");
const cell = (page: Page, row: number, col: number) =>
  page
    .locator(
      `revogr-data[type="rgRow"][col-type="rgCol"] .rgCell[data-rgrow="${row}"][data-rgcol="${col}"]`,
    )
    .first();
const title = (page: Page) => page.getByTestId("model-title");

async function fileMenu(page: Page, item: "New" | "Save" | "Load") {
  await page.getByRole("button", { name: "File" }).click();
  await page.getByRole("menuitem", { name: item }).click();
}

const formulaBar = (page: Page) => page.getByLabel("Formula bar");

/** Edits a cell through the formula bar. */
async function editCell(page: Page, row: number, col: number, text: string) {
  await cell(page, row, col).click();
  // Wait until the formula bar shows the clicked cell before typing into it.
  const address = `${String.fromCharCode(65 + col)}${row + 1}`;
  await expect(page.getByLabel("Cell address")).toHaveValue(address);
  await formulaBar(page).fill(text);
  await formulaBar(page).press("Enter");
}

const fontWeight = (page: Page, row: number, col: number) =>
  cell(page, row, col).evaluate((element) => getComputedStyle(element).fontWeight);

/** The mean shown in an uncertain cell ("mean ± SD"). */
async function shownMean(page: Page, row: number, col: number): Promise<number> {
  const text = (await cell(page, row, col).textContent()) ?? "";
  expect(text).toMatch(/^-?[0-9.]+ ± [0-9.]+$/);
  return Number(text.split(" ± ")[0]);
}

test.beforeEach(async ({ page }) => {
  // Use the download/upload fallbacks: the File System Access pickers can't be driven by tests.
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    delete w.showSaveFilePicker;
    delete w.showOpenFilePicker;
  });
  await page.goto("/");
});

test("starts with an empty model, a File menu and the toolbar", async ({ page }) => {
  await expect(title(page)).toHaveText("Untitled");
  await expect(tabs(page)).toHaveText(["Sheet1"]);
  await page.getByRole("button", { name: "File" }).click();
  await expect(page.getByRole("menuitem")).toHaveText(["New", "Save", "Load"]);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Test model" })).toBeVisible();
});

test("the toolbar button replaces the model with the test model", async ({ page }) => {
  await page.getByRole("button", { name: "Test model" }).click();
  await expect(title(page)).toHaveText("Test model");
  await expect(tabs(page)).toHaveText([
    "Option pricing",
    "Functions",
    "Deterministic",
    "Prices",
    "Lookups",
  ]);
  await expect(page.getByRole("navigation", { name: "Sheets" }).getByRole("button")).toHaveText([
    "Option pricing",
    "Functions",
    "Deterministic",
    "Prices",
    "Lookups",
  ]);
  await expect(cell(page, 0, 0)).toHaveText("Spot");
  await expect(cell(page, 0, 1)).toHaveText("100");
});

test("sheets can be tiled side by side and reopened from the sheet list", async ({ page }) => {
  await page.getByRole("button", { name: "Test model" }).click();
  // Let the first recalculation finish, so the grid isn't re-rendering during the drag.
  await expect(page.getByTestId("calc-status")).toHaveText(/runs/);
  // Drag the Functions tab to the right edge of the group to split the area. Native drag and
  // drop occasionally misses in headless Chromium, so retry the gesture until the split appears.
  await expect(async () => {
    const group = page.locator(".dv-groupview").first();
    const box = await group.boundingBox();
    if (!box) throw new Error("No tab group");
    await tabs(page)
      .filter({ hasText: "Functions" })
      .dragTo(group, { targetPosition: { x: box.width - 30, y: box.height / 2 } });
    await expect(page.locator(".dv-groupview")).toHaveCount(2, { timeout: 1000 });
  }).toPass({ timeout: 10_000 });

  // Close the Deterministic tab, then reopen it from the sheet list.
  const deterministic = tabs(page).filter({ hasText: "Deterministic" });
  await deterministic.click();
  await deterministic.locator(".dv-default-tab-action").click();
  await expect(deterministic).toHaveCount(0);
  await page.getByRole("navigation", { name: "Sheets" }).getByText("Deterministic").click();
  await expect(tabs(page).filter({ hasText: "Deterministic" })).toHaveCount(1);
});

test("asks before discarding unsaved changes", async ({ page }) => {
  await page.getByRole("button", { name: "Test model" }).click();
  await editCell(page, 0, 3, "42");
  await expect(title(page)).toHaveText("Test model •");

  await fileMenu(page, "New");
  await expect(page.getByText("Discard unsaved changes?")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(cell(page, 0, 3)).toHaveText("42");

  await fileMenu(page, "New");
  await page.getByRole("button", { name: "Discard changes" }).click();
  await expect(title(page)).toHaveText("Untitled");
  await expect(tabs(page)).toHaveText(["Sheet1"]);
});

test("saves and loads a model", async ({ page }) => {
  await page.getByRole("button", { name: "Test model" }).click();
  await editCell(page, 0, 3, "42");

  const downloading = page.waitForEvent("download");
  await fileMenu(page, "Save");
  const download = await downloading;
  expect(download.suggestedFilename()).toBe("Test model.fumoca");
  const saved = await readFile(await download.path());
  await expect(title(page)).toHaveText("Test model.fumoca");

  await fileMenu(page, "New");
  await expect(tabs(page)).toHaveText(["Sheet1"]);

  const choosing = page.waitForEvent("filechooser");
  await fileMenu(page, "Load");
  // Playwright stores downloads under a random name, so upload the contents under the real one.
  await (await choosing).setFiles({
    name: download.suggestedFilename(),
    mimeType: "application/json",
    buffer: saved,
  });
  await expect(title(page)).toHaveText("Test model.fumoca");
  await expect(tabs(page)).toHaveText([
    "Option pricing",
    "Functions",
    "Deterministic",
    "Prices",
    "Lookups",
  ]);
  await expect(cell(page, 0, 3)).toHaveText("42");
});

test("reports files that aren't fumoca workbooks", async ({ page }) => {
  const choosing = page.waitForEvent("filechooser");
  await fileMenu(page, "Load");
  await (await choosing).setFiles({
    name: "notes.fumoca",
    mimeType: "application/json",
    buffer: Buffer.from('{"hello":"world"}'),
  });
  await expect(page.getByText("The file is not a fumoca workbook")).toBeVisible();
  await expect(title(page)).toHaveText("Untitled");
});

test("cells show calculated answers, with root cells in bold", async ({ page }) => {
  await page.getByRole("button", { name: "Test model" }).click();
  await expect(page.getByTestId("calc-status")).toHaveText(/runs/);

  // Option pricing: inputs are roots; the call is an uncertain formula result.
  await expect(cell(page, 0, 1)).toHaveText("100");
  expect(Number(await fontWeight(page, 0, 1))).toBeGreaterThanOrEqual(700);
  expect(Math.abs((await shownMean(page, 7, 1)) - 8.02)).toBeLessThan(1);
  expect(Number(await fontWeight(page, 7, 1))).toBeLessThan(700);
  expect(Number(await fontWeight(page, 0, 0))).toBeLessThan(700); // text label

  // Deterministic: plain numbers, not formulas.
  await tabs(page).filter({ hasText: "Deterministic" }).click();
  await expect(cell(page, 1, 1)).toHaveText("1310");
  await expect(cell(page, 3, 1)).toHaveText("2334.125");
});

test("the formula bar shows and edits the selected cell", async ({ page }) => {
  await page.getByRole("button", { name: "Test model" }).click();
  await tabs(page).filter({ hasText: "Deterministic" }).click();

  await cell(page, 1, 1).click();
  await expect(page.getByLabel("Cell address")).toHaveValue("B2");
  await expect(formulaBar(page)).toHaveValue("=B1 * 1.08 - 40");

  await editCell(page, 0, 1, "2000");
  await expect(cell(page, 0, 1)).toHaveText("2000");
  await expect(cell(page, 1, 1)).toHaveText("2120");
  await expect(title(page)).toHaveText("Test model •");
  // Enter moves the selection down, as in Excel.
  await expect(page.getByLabel("Cell address")).toHaveValue("B2");
});

test("Escape reverts the formula bar, and syntax errors are rejected", async ({ page }) => {
  await page.getByRole("button", { name: "Test model" }).click();
  await tabs(page).filter({ hasText: "Deterministic" }).click();
  await cell(page, 1, 1).click();

  await formulaBar(page).fill("=999");
  await formulaBar(page).press("Escape");
  await expect(formulaBar(page)).toHaveValue("=B1 * 1.08 - 40");

  await formulaBar(page).fill("=1+");
  await formulaBar(page).press("Enter");
  await expect(page.getByText("Unexpected end of formula")).toBeVisible();
  await expect(cell(page, 1, 1)).toHaveText("1310");
  await expect(title(page)).toHaveText("Test model");
});

test("F2 edits the cell's formula in the grid", async ({ page }) => {
  await page.getByRole("button", { name: "Test model" }).click();
  await tabs(page).filter({ hasText: "Deterministic" }).click();

  await expect(page.getByTestId("calc-status")).toHaveText(/runs/);
  await cell(page, 1, 1).click();
  await expect(page.getByLabel("Cell address")).toHaveValue("B2");
  await page.keyboard.press("F2");
  const editor = page.getByLabel("Cell editor");
  await expect(editor).toHaveValue("=B1 * 1.08 - 40");
  await editor.fill("=B1 * 2");
  await editor.press("Enter");
  await expect(cell(page, 1, 1)).toHaveText("2500");
});

test("arrow up and down commit an in-cell edit and move", async ({ page }) => {
  const address = page.getByLabel("Cell address");
  const editor = page.getByLabel("Cell editor");
  await cell(page, 2, 1).click();
  await expect(address).toHaveValue("B3");

  // Down commits, as Enter does, and moves to the cell below.
  await page.keyboard.press("F2");
  await editor.fill("5");
  await editor.press("ArrowDown");
  await expect(cell(page, 2, 1)).toHaveText("5");
  await expect(address).toHaveValue("B4");

  // Up commits and moves to the cell above; the grid keeps the keyboard.
  await page.keyboard.press("F2");
  await editor.fill("=B3 * 2");
  await editor.press("ArrowUp");
  await expect(cell(page, 3, 1)).toHaveText("10");
  await expect(address).toHaveValue("B3");
  await page.keyboard.press("ArrowUp");
  await expect(address).toHaveValue("B2");

  // Typing into a cell starts an entry, which an arrow also commits.
  await page.keyboard.type("7");
  await expect(editor).toBeVisible();
  await page.keyboard.press("ArrowUp");
  await expect(cell(page, 1, 1)).toHaveText("7");
  await expect(address).toHaveValue("B1");
});

test("errors show as codes with the reason in a tooltip", async ({ page }) => {
  await editCell(page, 0, 0, "=FOO(1)");
  await editCell(page, 1, 0, "=A1 + 1");
  await expect(cell(page, 0, 0)).toHaveText("#NAME?");
  await expect(cell(page, 0, 0)).toHaveAttribute("title", "Unknown function FOO");
  await expect(cell(page, 1, 0)).toHaveText("#NAME?");
});

test("zero and cleared cells are committed", async ({ page }) => {
  await editCell(page, 0, 0, "0");
  await expect(cell(page, 0, 0)).toHaveText("0");
  await expect(title(page)).toHaveText("Untitled •");
  await editCell(page, 0, 0, "");
  await expect(cell(page, 0, 0)).toHaveText("");
});

const rowHeader = (page: Page, row: number) =>
  page
    .locator(`revogr-data[type="rgRow"][col-type="rowHeaders"] .rgCell[data-rgrow="${row}"]`)
    .first();

/** Filters a column to cells equal to a value, through RevoGrid's filter panel. */
async function filterColumn(page: Page, column: string, value: string) {
  const header = page
    .locator("revogr-header .rgHeaderCell")
    .filter({ hasText: new RegExp(`^${column}$`) });
  await header.first().hover();
  await header.first().locator("button.rv-filter").click();
  const panel = page.locator("revogr-filter-panel");
  await panel.locator("select#add-filter").selectOption("eq");
  await panel.locator(".multi-filter-list-container input").first().fill(value);
  await panel.locator("#revo-button-ok").click();
}

test("row numbers stay correct while a filter hides rows", async ({ page }) => {
  await page.getByRole("button", { name: "Test model" }).click();
  await expect(page.getByTestId("calc-status")).toHaveText(/runs/);
  await expect(rowHeader(page, 0)).toHaveText("1");
  await expect(rowHeader(page, 1)).toHaveText("2");
  const unfilteredColor = await rowHeader(page, 0).evaluate((e) => getComputedStyle(e).color);

  await filterColumn(page, "A", "Strike");
  // The first visible row is row 2 (Strike), and its number says so, in blue.
  await expect(cell(page, 0, 0)).toHaveText("Strike");
  await expect(rowHeader(page, 0)).toHaveText("2");
  await expect
    .poll(() => rowHeader(page, 0).evaluate((e) => getComputedStyle(e).color))
    .not.toBe(unfilteredColor);

  // Selection and editing use the real row.
  await cell(page, 0, 1).click();
  await expect(page.getByLabel("Cell address")).toHaveValue("B2");
  await expect(formulaBar(page)).toHaveValue("105");
  await page.keyboard.press("F2");
  await expect(page.getByLabel("Cell editor")).toHaveValue("105");
  await page.keyboard.press("Escape");

  // Enter moves to the next visible row, never a hidden one.
  await cell(page, 0, 1).click();
  await formulaBar(page).fill("110");
  await formulaBar(page).press("Enter");
  await expect(cell(page, 0, 1)).toHaveText("110");
  const next = await page.getByLabel("Cell address").inputValue();
  const visibleRows = await page
    .locator('revogr-data[type="rgRow"][col-type="rowHeaders"] .rgCell')
    .allTextContents();
  expect(visibleRows).toContain(next.slice(1));
});

test("the exact option prices follow the inputs, and Monte Carlo agrees", async ({ page }) => {
  await page.getByRole("button", { name: "Test model" }).click();
  await expect(page.getByTestId("calc-status")).toHaveText(/runs/);
  await expect(cell(page, 13, 1)).toHaveText("8.021352235"); // B14: Black–Scholes call
  await expect(cell(page, 14, 1)).toHaveText("7.900441808"); // B15: Black–Scholes put

  await editCell(page, 0, 1, "120"); // Spot
  await expect(cell(page, 13, 1)).toHaveText("22.24310317");
  await expect(cell(page, 14, 1)).toHaveText("2.122192738");

  // Monte Carlo − exact (B17, B18) and discounted stock − spot (B19) are close to zero.
  for (const row of [16, 17, 18]) {
    expect(Math.abs(await shownMean(page, row, 1))).toBeLessThan(1);
  }
});

test("uncertain cells show a histogram of their samples in the background", async ({ page }) => {
  await page.getByRole("button", { name: "Test model" }).click();
  await expect(page.getByTestId("calc-status")).toHaveText(/runs/);
  const background = (row: number, col: number) =>
    cell(page, row, col).evaluate((element) => getComputedStyle(element).backgroundImage);
  // B7 (terminal price) and B8 (call payoff) are uncertain.
  expect(await background(6, 1)).toContain("svg");
  expect(await background(7, 1)).toContain("svg");
  // B1 (a root number), B14 (deterministic formula) and A1 (a label) have no histogram.
  expect(await background(0, 1)).toBe("none");
  expect(await background(13, 1)).toBe("none");
  expect(await background(0, 0)).toBe("none");
});

/** Opens the Config menu and applies iteration counts. */
async function configure(page: Page, values: { cpu?: string; gpu?: string }) {
  await page.getByRole("button", { name: "Config" }).click();
  if (values.cpu !== undefined) await page.getByLabel("CPU iterations").fill(values.cpu);
  if (values.gpu !== undefined) await page.getByLabel("GPU iterations").fill(values.gpu);
  await page.getByRole("button", { name: "Apply" }).click();
}

test("the Config menu sets the CPU iterations, and remembers them", async ({ page }) => {
  await expect(page.getByTestId("calc-status")).toHaveText("CPU · 10,000 runs");
  await page.getByRole("button", { name: "Config" }).click();
  await expect(page.getByLabel("CPU iterations")).toHaveValue("10,000");
  // No WebGPU in this browser: the GPU field is disabled and says why.
  await expect(page.getByLabel("GPU iterations")).toBeDisabled();
  await expect(page.getByText("WebGPU is not available in this browser")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();

  await configure(page, { cpu: "5000" });
  await expect(page.getByTestId("calc-status")).toHaveText("CPU · 5,000 runs");
  await page.getByRole("button", { name: "Test model" }).click();
  await expect(cell(page, 1, 1)).toHaveText("105");

  await page.reload();
  await expect(page.getByTestId("calc-status")).toHaveText("CPU · 5,000 runs");
});

test("the Config menu requires at least one engine", async ({ page }) => {
  await configure(page, { cpu: "0" });
  await expect(page.getByText("At least one engine must run")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByTestId("calc-status")).toHaveText("CPU · 10,000 runs");
});

test("with both engines, the GPU's results are shown and the CPU agrees @gpu", async ({ page }) => {
  await page.getByRole("button", { name: "Test model" }).click();
  await expect(page.getByTestId("calc-status")).toHaveText("GPU 100,000 + CPU 10,000 · agree", {
    timeout: 20_000,
  });
  // The arrow keys step GPU iterations by 100,000.
  await page.getByRole("button", { name: "Config" }).click();
  const gpuIterations = page.getByLabel("GPU iterations");
  await gpuIterations.press("ArrowUp");
  await expect(gpuIterations).toHaveValue("200,000");
  await gpuIterations.press("ArrowDown");
  await expect(gpuIterations).toHaveValue("100,000");
  await page.getByRole("button", { name: "Cancel" }).click();

  await configure(page, { cpu: "0" });
  await expect(page.getByTestId("calc-status")).toHaveText("GPU · 100,000 runs");
  await configure(page, { cpu: "20000", gpu: "0" });
  await expect(page.getByTestId("calc-status")).toHaveText("CPU · 20,000 runs");
});

async function modelMenu(page: Page, item: "New sheet" | "New series sheet") {
  await page.getByRole("button", { name: "Model", exact: true }).click();
  await page.getByRole("menuitem", { name: item }).click();
}

const background = (page: Page, row: number, col: number) =>
  cell(page, row, col).evaluate((element) => getComputedStyle(element).backgroundColor);
const RED = "rgba(250, 82, 82, 0.18)";

test("Model → New sheet adds and opens a sheet", async ({ page }) => {
  await modelMenu(page, "New sheet");
  await expect(tabs(page)).toHaveText(["Sheet1", "Sheet2"]);
  await expect(page.getByRole("navigation", { name: "Sheets" }).getByRole("button")).toHaveText([
    "Sheet1",
    "Sheet2",
  ]);
  await expect(title(page)).toHaveText("Untitled •");
});

const granularity = (page: Page) => page.locator('input[aria-label="Granularity"]');
const seriesRows = (page: Page) =>
  page.locator('revogr-data[type="rgRow"][col-type="rgCol"] .rgCell[data-rgcol="0"]');

test("Model → New series sheet creates an empty monthly sheet with one row to type into", async ({
  page,
}) => {
  await modelMenu(page, "New series sheet");
  await expect(tabs(page)).toHaveText(["Sheet1", "Series1"]);
  await expect(granularity(page)).toHaveValue("Monthly");
  await expect(page.locator('input[aria-label="Type"]')).toHaveValue("Level");
  // Headers name the columns; there are no row numbers.
  await expect(page.locator("revogr-header .rgHeaderCell .header-content")).toHaveText([
    "Period",
    "Value",
  ]);
  await expect(page.locator('revogr-data[col-type="rowHeaders"] .rgCell')).toHaveCount(0);
  // Empty, with a single row; typing into the last row adds another below it.
  await expect(seriesRows(page)).toHaveCount(1);
  await expect(cell(page, 0, 0)).toHaveText("");
  await editCell(page, 0, 0, "2026-01");
  await expect(seriesRows(page)).toHaveCount(2);
  await editCell(page, 1, 0, "2026-02");
  await expect(seriesRows(page)).toHaveCount(3);
  expect(await background(page, 1, 0)).not.toBe(RED);

  // A day in a monthly sheet is the wrong granularity: the whole row turns red.
  await editCell(page, 2, 0, "2026-03-15");
  await expect.poll(() => background(page, 2, 0)).toBe(RED);
  expect(await background(page, 2, 1)).toBe(RED);
  expect(await background(page, 1, 0)).not.toBe(RED);

  // Switching the sheet to daily flips which rows are wrong.
  await granularity(page).click();
  await page.getByRole("option", { name: "Daily" }).click();
  await expect.poll(() => background(page, 2, 0)).not.toBe(RED);
  expect(await background(page, 1, 0)).toBe(RED);

  await page.locator('input[aria-label="Type"]').click();
  await page.getByRole("option", { name: "Flow" }).click();
  await expect(page.locator('input[aria-label="Type"]')).toHaveValue("Flow");
});

test("the first period typed into an empty series sheet sets its granularity", async ({ page }) => {
  await modelMenu(page, "New series sheet");
  await expect(granularity(page)).toHaveValue("Monthly");
  await editCell(page, 0, 0, "2026-Q1");
  await expect(granularity(page)).toHaveValue("Quarterly");
  expect(await background(page, 0, 0)).not.toBe(RED);
  // Loosely typed periods are written properly.
  await editCell(page, 1, 0, "2026-q2");
  await expect(cell(page, 1, 0)).toHaveText("2026-Q2");
  // Once there are periods, a different granularity is marked wrong, not adopted.
  await editCell(page, 2, 0, "2026-5");
  await expect(cell(page, 2, 0)).toHaveText("2026-05"); // 2026-5 is written as 2026-05
  await expect(granularity(page)).toHaveValue("Quarterly");
  await expect.poll(() => background(page, 2, 0)).toBe(RED);
});

test("duplicate periods show an error, and periods out of order can be sorted", async ({
  page,
}) => {
  await modelMenu(page, "New series sheet");
  await editCell(page, 0, 0, "2026-03");
  await editCell(page, 0, 1, "30");
  await editCell(page, 1, 0, "2026-01");
  await editCell(page, 1, 1, "10");
  await expect(page.getByText("Warning: your dates are out of order")).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "Duplicate" })).toHaveCount(0);

  await editCell(page, 2, 0, "2026-03");
  await expect(page.getByText("Duplicate period: 2026-03 (rows 1, 3)")).toBeVisible();

  await page.getByRole("button", { name: "Sort now" }).click();
  await expect(cell(page, 0, 0)).toHaveText("2026-01");
  await expect(cell(page, 0, 1)).toHaveText("10"); // values move with their period
  await expect(cell(page, 1, 0)).toHaveText("2026-03");
  await expect(cell(page, 1, 1)).toHaveText("30");
  await expect(page.getByText("Warning: your dates are out of order")).toHaveCount(0);
  await expect(page.getByText("Duplicate period: 2026-03 (rows 2, 3)")).toBeVisible();
});

test("series sheets can have several value columns, renamed by double-clicking the header", async ({
  page,
}) => {
  await modelMenu(page, "New series sheet");
  await page.getByRole("button", { name: "Add value column" }).click();
  const headers = page.locator("revogr-header .rgHeaderCell .header-content");
  await expect(headers).toHaveText(["Period", "Value", "Value2"]);

  await headers.filter({ hasText: "Value2" }).dblclick();
  const name = page.getByLabel("Column name");
  await expect(name).toHaveValue("Value2");
  await name.fill("value");
  await page.getByRole("button", { name: "Rename" }).click();
  await expect(page.getByText("There is already a column called Value")).toBeVisible();
  await name.fill("Close");
  await page.getByRole("button", { name: "Rename" }).click();
  await expect(headers).toHaveText(["Period", "Value", "Close"]);
});

test("formulas look up values from series sheets", async ({ page }) => {
  await page.getByRole("button", { name: "Test model" }).click();
  await expect(page.getByTestId("calc-status")).toHaveText(/runs/);
  await tabs(page).filter({ hasText: "Lookups" }).click();
  await expect(cell(page, 1, 1)).toHaveText("103.2"); // =Prices[Close]@2026-03
  await expect(cell(page, 2, 1)).toHaveText("101.5"); // =Prices@2026-02 (first column, Open)
  await expect(cell(page, 4, 1)).toHaveText("102.7"); // =Prices[Close]@B4
  await expect(cell(page, 7, 1)).toHaveText("#N/A");
  await expect(cell(page, 7, 1)).toHaveAttribute("title", "Prices has no row for 2027-01");

  // Changing the series value updates the lookup.
  await tabs(page).filter({ hasText: "Prices" }).click();
  await editCell(page, 2, 2, "110"); // Close for 2026-03
  await tabs(page).filter({ hasText: "Lookups" }).click();
  await expect(cell(page, 1, 1)).toHaveText("110");
});

test("GPU results show exact inputs exactly, including lookups @gpu", async ({ page }) => {
  await page.getByRole("button", { name: "Test model" }).click();
  await expect(page.getByTestId("calc-status")).toHaveText(/agree/, { timeout: 20_000 });
  await tabs(page).filter({ hasText: "Lookups" }).click();
  await expect(cell(page, 1, 1)).toHaveText("103.2"); // not 103.1999969 (f32 rounding)
  await expect(cell(page, 2, 1)).toHaveText("101.5");
  await expect(cell(page, 4, 1)).toHaveText("102.7");
});

test("results update while a long run is in progress", async ({ page }) => {
  await configure(page, { cpu: "300000" });
  await page.getByRole("button", { name: "Test model" }).click();
  // Progress appears while batches arrive, then the final count.
  await expect(page.getByTestId("calc-status")).toHaveText(/^CPU [\d,]+ \/ 300,000$/);
  await expect(cell(page, 7, 1)).toHaveText(/ ± /); // answers show before the run finishes
  await expect(page.getByTestId("calc-status")).toHaveText("CPU · 300,000 runs", {
    timeout: 60_000,
  });
});

test("the GPU runs 1,000,000 iterations in batches, updating as it goes @gpu", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await configure(page, { gpu: "1000000" });
  await page.getByRole("button", { name: "Test model" }).click();
  await expect(page.getByTestId("calc-status")).toHaveText(/GPU [\d,]+ \/ 1,000,000/);
  await expect(page.getByTestId("calc-status")).toHaveText("GPU 1,000,000 + CPU 10,000 · agree", {
    timeout: 60_000,
  });
  await expect(cell(page, 13, 1)).toHaveText(/^8\.0213\d*$/); // exact call, to f32 accuracy
  expect(errors).toEqual([]);
});

test("GPU iterations can be set to 10,000,000 @gpu", async ({ page }) => {
  await page.getByRole("button", { name: "Test model" }).click();
  await configure(page, { gpu: "10000000" });
  await expect(page.getByText(/iterations must be/)).toHaveCount(0);
  await expect(page.getByTestId("calc-status")).toHaveText(/GPU [\d,]+ \/ 10,000,000/);
});

test("Ctrl+; fills in the next period on a series sheet", async ({ page }) => {
  const month = (offset: number) => {
    const now = new Date();
    const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  };
  await modelMenu(page, "New series sheet");

  // With nothing above: the current month.
  await cell(page, 0, 0).click();
  await expect(page.getByLabel("Cell address")).toHaveValue("A1");
  await page.keyboard.press("Control+;");
  await expect(cell(page, 0, 0)).toHaveText(month(0));

  // With periods above: the latest plus one, even from a value column of the row.
  await cell(page, 1, 1).click();
  await expect(page.getByLabel("Cell address")).toHaveValue("B2");
  await page.keyboard.press("Control+;");
  await expect(cell(page, 1, 0)).toHaveText(month(1));

  // In the formula bar, it fills the draft for a time cell; Enter commits it.
  await cell(page, 2, 0).click();
  await expect(page.getByLabel("Cell address")).toHaveValue("A3");
  await formulaBar(page).focus();
  await page.keyboard.press("Control+;");
  await expect(formulaBar(page)).toHaveValue(month(2));
  await formulaBar(page).press("Enter");
  await expect(cell(page, 2, 0)).toHaveText(month(2));
});

test("recalculation waits for a pause after a cell edit", async ({ page }) => {
  await editCell(page, 0, 0, "=1+1");
  // The edited cell shows what was typed until the debounced run (500 ms) reports.
  await expect(cell(page, 0, 0)).toHaveText("=1+1");
  await page.waitForTimeout(300);
  await expect(cell(page, 0, 0)).toHaveText("=1+1");
  await expect(cell(page, 0, 0)).toHaveText("2");

  // A burst of edits runs once, with the last values.
  await editCell(page, 0, 0, "=3");
  await editCell(page, 1, 0, "=A1*2");
  await expect(cell(page, 1, 0)).toHaveText("6");
  await expect(cell(page, 0, 0)).toHaveText("3");
});
