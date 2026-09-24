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
  await expect(tabs(page)).toHaveText(["Option pricing", "Functions", "Deterministic"]);
  await expect(page.getByRole("navigation", { name: "Sheets" }).getByRole("button")).toHaveText([
    "Option pricing",
    "Functions",
    "Deterministic",
  ]);
  await expect(cell(page, 0, 0)).toHaveText("Spot");
  await expect(cell(page, 0, 1)).toHaveText("100");
});

test("sheets can be tiled side by side and reopened from the sheet list", async ({ page }) => {
  await page.getByRole("button", { name: "Test model" }).click();
  // Let the first recalculation finish, so the grid isn't re-rendering during the drag.
  await expect(page.getByTestId("calc-status")).toHaveText(/samples/);
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
  await expect(tabs(page)).toHaveText(["Option pricing", "Functions", "Deterministic"]);
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
  await expect(page.getByTestId("calc-status")).toHaveText(/samples/);

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

  await expect(page.getByTestId("calc-status")).toHaveText(/samples/);
  await cell(page, 1, 1).click();
  await expect(page.getByLabel("Cell address")).toHaveValue("B2");
  await page.keyboard.press("F2");
  const editor = page.getByLabel("Cell editor");
  await expect(editor).toHaveValue("=B1 * 1.08 - 40");
  await editor.fill("=B1 * 2");
  await editor.press("Enter");
  await expect(cell(page, 1, 1)).toHaveText("2500");
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
  await expect(page.getByTestId("calc-status")).toHaveText(/samples/);
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
  await expect(page.getByTestId("calc-status")).toHaveText(/samples/);
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
