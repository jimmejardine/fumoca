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
  // Wait until the formula bar shows the clicked cell before typing into it. The name box shows a
  // named cell's name, so check the address it holds.
  const address = `${String.fromCharCode(65 + col)}${row + 1}`;
  await expect(page.getByLabel("Cell address")).toHaveAttribute("data-address", address);
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

test("Escape reverts the formula bar, and syntax errors show as #ERROR!", async ({ page }) => {
  await page.getByRole("button", { name: "Test model" }).click();
  await tabs(page).filter({ hasText: "Deterministic" }).click();
  await cell(page, 1, 1).click();

  await formulaBar(page).fill("=999");
  await formulaBar(page).press("Escape");
  await expect(formulaBar(page)).toHaveValue("=B1 * 1.08 - 40");

  // A formula with a syntax error is kept as typed, so it can be fixed rather than retyped.
  await formulaBar(page).fill("=B1 * 1.08 -");
  await formulaBar(page).press("Enter");
  await expect(cell(page, 1, 1)).toHaveText("#ERROR!");
  await expect(cell(page, 1, 1)).toHaveAttribute("title", /Unexpected end of formula/);
  await cell(page, 1, 1).click();
  await expect(page.getByLabel("Cell address")).toHaveValue("B2");
  await expect(formulaBar(page)).toHaveValue("=B1 * 1.08 -");
  await formulaBar(page).fill("=B1 * 1.08 - 40");
  await formulaBar(page).press("Enter");
  await expect(cell(page, 1, 1)).toHaveText("1310");
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

test("a formula's dependencies get coloured borders, matching the formula's text", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Test model" }).click();
  await tabs(page).filter({ hasText: "Deterministic" }).click();
  const outline = (row: number, col: number) =>
    cell(page, row, col).evaluate((element) => {
      const style = getComputedStyle(element);
      return style.outlineStyle === "none" ? null : style.outlineColor;
    });
  const textColor = (label: string, address: string) =>
    page
      .getByLabel(label)
      .locator("..")
      .locator(`[data-reference="${address}"]`)
      .first()
      .evaluate((element) => getComputedStyle(element).color);

  // B2 is =B1 * 1.08 - 40: B1 gets a border in the colour B1 has in the formula bar.
  await cell(page, 1, 1).click();
  await expect(page.getByLabel("Cell address")).toHaveValue("B2");
  await expect.poll(() => outline(0, 1)).not.toBeNull();
  expect(await outline(0, 1)).toBe(await textColor("Formula bar", "B1"));
  expect(await outline(1, 1)).toBeNull();

  // A cell holding a value depends on nothing.
  await cell(page, 0, 1).click();
  await expect(page.getByLabel("Cell address")).toHaveValue("B1");
  await expect.poll(() => outline(0, 1)).toBeNull();

  // References are coloured as they're typed, each in its own colour.
  await formulaBar(page).fill("=B1 + A1 * B1");
  const b1 = await textColor("Formula bar", "B1");
  expect(await textColor("Formula bar", "A1")).not.toBe(b1);
  await formulaBar(page).press("Escape");

  // The in-cell editor colours them too.
  await cell(page, 1, 1).click();
  await expect(page.getByLabel("Cell address")).toHaveValue("B2");
  await page.keyboard.press("F2");
  await expect(page.getByLabel("Cell editor")).toHaveValue("=B1 * 1.08 - 40");
  expect(await textColor("Cell editor", "B1")).toBe(await outline(0, 1));
});

test("clicking a cell while editing a formula inserts its address", async ({ page }) => {
  const address = page.getByLabel("Cell address");
  await editCell(page, 0, 1, "3"); // B1
  await editCell(page, 1, 0, "4"); // A2

  // In the formula bar: the clicked cell's address goes in, and the selection stays on B3.
  await cell(page, 2, 1).click();
  await expect(address).toHaveValue("B3");
  await formulaBar(page).fill("=");
  await cell(page, 0, 1).click();
  await expect(formulaBar(page)).toHaveValue("=B1");
  await expect(address).toHaveValue("B3");
  await page.keyboard.type("*");
  await expect(formulaBar(page)).toHaveValue("=B1*");
  await cell(page, 0, 0).click();
  await expect(formulaBar(page)).toHaveValue("=B1*A1");
  // Clicking again replaces the address just inserted.
  await cell(page, 1, 0).click();
  await expect(formulaBar(page)).toHaveValue("=B1*A2");
  await formulaBar(page).press("Enter");
  await expect(cell(page, 2, 1)).toHaveText("12");

  // In the cell: typing = starts a formula, and a click adds the reference.
  await cell(page, 0, 2).click();
  await expect(address).toHaveValue("C1");
  await page.keyboard.type("=");
  const editor = page.getByLabel("Cell editor");
  await expect(editor).toHaveValue("=");
  await cell(page, 1, 0).click();
  await expect(editor).toHaveValue("=A2");
  await editor.press("Enter");
  await expect(cell(page, 0, 2)).toHaveText("4");

  // Where no reference can go (after a number), a click commits and selects, as before.
  await cell(page, 4, 1).click();
  await expect(address).toHaveValue("B5");
  await formulaBar(page).fill("=1");
  await cell(page, 0, 0).click();
  await expect(address).toHaveValue("A1");
  await expect(cell(page, 4, 1)).toHaveText("1");
});

test("arrow keys point at cells while a reference can go in the cell editor", async ({ page }) => {
  const address = page.getByLabel("Cell address");
  const editor = page.getByLabel("Cell editor");
  await editCell(page, 0, 0, "3"); // A1
  await editCell(page, 0, 1, "4"); // B1
  const outlined = (row: number, col: number) =>
    cell(page, row, col).evaluate((element) => getComputedStyle(element).outlineStyle !== "none");

  await cell(page, 2, 2).click();
  await expect(address).toHaveValue("C3");
  await page.keyboard.type("=");
  await expect(editor).toHaveValue("=");
  // From the edited cell: left to B3, then up twice to B1, outlined as it goes.
  await page.keyboard.press("ArrowLeft");
  await expect(editor).toHaveValue("=B3");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(editor).toHaveValue("=B1");
  await expect.poll(() => outlined(0, 1)).toBe(true);
  await expect.poll(() => outlined(2, 1)).toBe(false);
  // After an operator, pointing starts again from the edited cell.
  await page.keyboard.type("+");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(editor).toHaveValue("=B1+A1");
  // Where no reference can go, an arrow commits as before.
  await page.keyboard.type("*2");
  await page.keyboard.press("ArrowDown");
  await expect(cell(page, 2, 2)).toHaveText("10");
  await expect(address).toHaveValue("C4");
});

test("formulas reference cells on other sheets, and can point at them", async ({ page }) => {
  await modelMenu(page, "New sheet");
  await expect(tabs(page).filter({ hasText: "Sheet2" })).toHaveCount(1);
  await editCell(page, 0, 0, "5"); // Sheet2!A1

  // Typed: Sheet1!B1 = Sheet2!A1 * 2.
  await tabs(page).filter({ hasText: "Sheet1" }).click();
  await editCell(page, 0, 1, "=Sheet2!A1 * 2");
  await expect(cell(page, 0, 1)).toHaveText("10");

  // Tile Sheet2 to the right of Sheet1.
  await expect(async () => {
    const group = page.locator(".dv-groupview").first();
    const box = await group.boundingBox();
    if (!box) throw new Error("No tab group");
    await tabs(page)
      .filter({ hasText: "Sheet2" })
      .dragTo(group, { targetPosition: { x: box.width - 30, y: box.height / 2 } });
    await expect(page.locator(".dv-groupview")).toHaveCount(2, { timeout: 1000 });
  }).toPass({ timeout: 10_000 });
  const cellIn = (group: number, row: number, col: number) =>
    page
      .locator(".dv-groupview")
      .nth(group)
      .locator(
        `revogr-data[type="rgRow"][col-type="rgCol"] .rgCell[data-rgrow="${row}"][data-rgcol="${col}"]`,
      )
      .first();
  await expect(cellIn(1, 0, 0)).toHaveText("5");

  // Selecting B1 outlines Sheet2!A1, in the colour it has in the formula.
  await cellIn(0, 0, 1).click();
  await expect(page.getByLabel("Cell address")).toHaveValue("B1");
  const outline = () =>
    cellIn(1, 0, 0).evaluate((element) => {
      const style = getComputedStyle(element);
      return style.outlineStyle === "none" ? null : style.outlineColor;
    });
  await expect.poll(outline).not.toBeNull();
  const reference = formulaBar(page).locator("..").locator('[data-reference="sheet2!A1"]');
  expect(await reference.evaluate((element) => getComputedStyle(element).color)).toBe(
    await outline(),
  );

  // Pointing at a cell on the other sheet inserts it with its sheet name.
  await cellIn(0, 1, 1).click();
  await expect(page.getByLabel("Cell address")).toHaveValue("B2");
  await formulaBar(page).fill("=");
  await cellIn(1, 0, 0).click();
  await expect(formulaBar(page)).toHaveValue("=Sheet2!A1");
  await page.keyboard.type("+1");
  await formulaBar(page).press("Enter");
  await expect(cellIn(0, 1, 1)).toHaveText("6");
});

test("copied and filled formulas shift their references, as in Excel", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const address = page.getByLabel("Cell address");
  await editCell(page, 0, 0, "2"); // A1
  await editCell(page, 1, 0, "3"); // A2
  await editCell(page, 0, 1, "=A1*10"); // B1
  await editCell(page, 0, 2, "=$A$1+A1"); // C1
  await expect(cell(page, 0, 1)).toHaveText("20");

  // Copy B1 and paste into B2: the relative reference moves down a row.
  await cell(page, 0, 1).click();
  await expect(address).toHaveValue("B1");
  await page.keyboard.press("Control+c");
  await cell(page, 1, 1).click();
  await expect(address).toHaveValue("B2");
  await page.keyboard.press("Control+v");
  await expect(cell(page, 1, 1)).toHaveText("30");
  await expect(formulaBar(page)).toHaveValue("=A2*10");

  // Anchored parts stay put.
  await cell(page, 0, 2).click();
  await expect(address).toHaveValue("C1");
  await page.keyboard.press("Control+c");
  await cell(page, 1, 2).click();
  await expect(address).toHaveValue("C2");
  await page.keyboard.press("Control+v");
  await expect(cell(page, 1, 2)).toHaveText("5");
  await expect(formulaBar(page)).toHaveValue("=$A$1+A2");

  // The fill handle: drag B2 down to B4.
  await editCell(page, 2, 0, "4"); // A3
  await expect(async () => {
    await cell(page, 1, 1).click();
    const handle = page.locator(".autofill-handle").first();
    const target = await cell(page, 3, 1).boundingBox();
    if (!target) throw new Error("no target cell");
    await handle.hover();
    await page.mouse.down();
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 5 });
    await page.mouse.up();
    await expect(cell(page, 2, 1)).toHaveText("40", { timeout: 1000 });
  }).toPass({ timeout: 10_000 });
  await expect(cell(page, 3, 1)).toHaveText("0");
  await cell(page, 3, 1).click();
  await expect(formulaBar(page)).toHaveValue("=A4*10");
});

test("scenarios are created from the side panel, and defined by clicking cells", async ({
  page,
}) => {
  await editCell(page, 0, 0, "2"); // A1
  await editCell(page, 1, 0, "5"); // A2
  await editCell(page, 0, 1, "=A1*10 + A2"); // B1

  await page.getByRole("tab", { name: "Scenarios" }).click();
  await page.getByRole("button", { name: "New scenario" }).click();
  await expect(tabs(page).filter({ hasText: "Scenario1" })).toHaveCount(1);
  await expect(
    page.getByRole("navigation", { name: "Scenarios" }).getByText("Scenario1"),
  ).toBeVisible();
  const name = page.getByLabel("Scenario name");
  await name.fill("Rates");
  await name.press("Enter");
  await expect(tabs(page).filter({ hasText: "Rates" })).toHaveCount(1);

  // A single-cell dimension: its new picker has focus, so clicking A1 picks it.
  await page.getByRole("button", { name: "Single cell" }).click();
  const dimensionCell = page.getByLabel("Dimension cell");
  await expect(dimensionCell).toBeFocused();
  await cell(page, 0, 0).click();
  await expect(dimensionCell).toHaveValue("Sheet1!A1");
  await expect(page.getByText("Baseline: 2")).toBeVisible();
  for (const [i, value] of ["3", "4"].entries()) {
    await page.getByRole("button", { name: "Alternative", exact: true }).click();
    await page.getByLabel(`Alternative ${i + 1}`, { exact: true }).fill(value);
    await page.getByLabel(`Alternative ${i + 1}`, { exact: true }).press("Enter");
  }

  // A group of one cell (A2) with two variants.
  await page.getByRole("button", { name: "Group", exact: true }).click();
  await page.getByRole("button", { name: "Cell", exact: true }).click();
  await expect(page.getByLabel("Group cell 1", { exact: true })).toBeFocused();
  await cell(page, 1, 0).click();
  await expect(page.getByLabel("Group cell 1", { exact: true })).toHaveValue("Sheet1!A2");
  await page.getByRole("button", { name: "Variant", exact: true }).click();
  await page.getByRole("button", { name: "Variant", exact: true }).click();
  await page.getByLabel("Variant 1 cell 1").fill("50");
  await page.getByLabel("Variant 1 cell 1").press("Enter");

  // The output: typed rather than clicked.
  await page.getByRole("button", { name: "Output", exact: true }).click();
  await page.getByLabel("Output 1", { exact: true }).fill("sheet1!b1");
  await page.getByLabel("Output 1", { exact: true }).press("Enter");
  await expect(page.getByLabel("Output 1", { exact: true })).toHaveValue("Sheet1!B1");

  await expect(page.getByTestId("combination-count")).toHaveText(
    "2 × 2 = 4 combinations, plus the Baseline",
  );
  // Picking cells didn't change the grid's selection or contents.
  await expect(cell(page, 0, 1)).toHaveText("25");
  await expect(title(page)).toHaveText("Untitled •");

  // Run it: B1 = A1 * 10 + A2, with A1 in {3, 4} down the rows and the group across.
  await page.getByRole("button", { name: "Run scenario" }).click();
  await expect(page.getByTestId("scenario-progress")).toHaveText(
    "Ran the Baseline and 4 combinations",
  );
  const pivot = page.getByTestId("scenario-pivot");
  const values = () => pivot.locator("tbody button").allTextContents();
  await expect.poll(values).toEqual(["80", "35", "90", "45"]);
  await expect(page.getByText("Baseline: Sheet1!B1 = 25")).toBeVisible();

  // All dimensions down the rows: one row per combination.
  await page.locator(`[data-field="Group1"]`).getByText("Group1").click();
  await page.getByRole("menuitem", { name: "Rows" }).click();
  await expect(pivot.locator("tbody tr")).toHaveCount(4);
  await expect.poll(values).toEqual(["80", "35", "90", "45"]);
  // Sorted by the output, largest first.
  await pivot.getByRole("button", { name: "Sort by column 1" }).click();
  await pivot.getByRole("button", { name: "Sort by column 1" }).click();
  await expect.poll(values).toEqual(["90", "80", "45", "35"]);

  // The group as a filter, pooled: each row mixes both variants (still sorted, largest first).
  await page.locator(`[data-field="Group1"]`).getByText("Group1").click();
  await page.getByRole("menuitem", { name: "Filters" }).click();
  await page.getByRole("combobox", { name: "Group1 filter" }).click();
  await page.getByRole("option", { name: "All (pooled)" }).click();
  await expect
    .poll(values)
    .toEqual([expect.stringMatching(/^6[78] ± 2[23]$/), expect.stringMatching(/^5[78] ± 2[23]$/)]);

  // Compared with the Baseline (25).
  await page.getByRole("combobox", { name: "Group1 filter" }).click();
  await page.getByRole("option", { name: "Variant 1" }).click();
  await page.getByRole("switch", { name: "Compare with Baseline" }).click({ force: true });
  await expect.poll(values).toEqual(["+65 (+260.0%)", "+55 (+220.0%)"]);

  // Editing the model marks the results as out of date.
  await tabs(page).filter({ hasText: "Sheet1" }).click();
  await editCell(page, 2, 0, "1");
  await expect(
    page.getByText("The model or the scenario has changed since this run."),
  ).toBeVisible();
});

test("cells are named in the name box, used in formulas, and jumped to", async ({ page }) => {
  const nameBox = page.getByLabel("Cell address");
  const nameCell = async (row: number, col: number, name: string) => {
    await cell(page, row, col).click();
    await expect(nameBox).toHaveAttribute(
      "data-address",
      `${String.fromCharCode(65 + col)}${row + 1}`,
    );
    await nameBox.fill(name);
    await nameBox.press("Enter");
    await expect(nameBox).toHaveValue(name);
  };
  await editCell(page, 0, 1, "100"); // B1
  await nameCell(0, 1, "Spot");
  await editCell(page, 0, 2, "=Spot*2"); // C1
  await expect(cell(page, 0, 2)).toHaveText("200");

  // Renaming rewrites the formulas that use the name.
  await nameCell(0, 1, "Price");
  await cell(page, 0, 2).click();
  await expect(formulaBar(page)).toHaveValue("=Price*2");
  await expect(cell(page, 0, 2)).toHaveText("200");

  // Names must follow the rules; an existing name or an address jumps there.
  await cell(page, 1, 1).click();
  await expect(nameBox).toHaveAttribute("data-address", "B2");
  await nameBox.fill("1x");
  await nameBox.press("Enter");
  await expect(page.getByText("A name starts with a letter or _")).toBeVisible();
  await nameBox.press("Escape");
  await nameBox.fill("price");
  await nameBox.press("Enter");
  await expect(nameBox).toHaveAttribute("data-address", "B1");
  await nameBox.fill("C12");
  await nameBox.press("Enter");
  await expect(nameBox).toHaveAttribute("data-address", "C12");

  // Clicking a named cell while writing a formula inserts its name. (Jumping to C12 scrolled
  // the grid, so jump back to the top first.)
  await nameBox.fill("D1");
  await nameBox.press("Enter");
  await expect(nameBox).toHaveAttribute("data-address", "D1");
  await formulaBar(page).fill("=");
  await cell(page, 0, 1).click();
  await expect(formulaBar(page)).toHaveValue("=Price");
  await formulaBar(page).press("Escape");

  // A name on another sheet, and one more here.
  await nameCell(1, 1, "Alpha");
  await modelMenu(page, "New sheet");
  await expect(tabs(page).filter({ hasText: "Sheet2" })).toHaveCount(1);
  await editCell(page, 0, 0, "0.1");
  await nameCell(0, 0, "Growth");
  await tabs(page).filter({ hasText: "Sheet1" }).click();
  await cell(page, 0, 3).click();

  // The dropdown lists this sheet's names A–Z, then the others'; choosing one jumps to it.
  await page.getByLabel("Named cells").click();
  await expect(page.getByRole("option")).toHaveText([
    /^AlphaB2$/,
    /^PriceB1$/,
    /^GrowthSheet2!A1$/,
  ]);
  await page.getByRole("option", { name: /Growth/ }).click();
  await expect(nameBox).toHaveValue("Growth");
  await expect(nameBox).toHaveAttribute("data-address", "A1");
  await expect(cell(page, 0, 0)).toHaveText("0.1");
});

test("a scenario picks a named cell by clicking it, or by its name", async ({ page }) => {
  await page.getByRole("button", { name: "Test model" }).click();
  await page.getByRole("tab", { name: "Scenarios" }).click();
  await page.getByRole("button", { name: "New scenario" }).click();
  await page.getByRole("button", { name: "Single cell" }).click();
  const dimensionCell = page.getByLabel("Dimension cell");
  await expect(dimensionCell).toBeFocused();
  // B4 is named Volatility: clicking it picks the cell, shown by its name.
  await cell(page, 3, 1).click();
  await expect(dimensionCell).toHaveValue("Volatility");
  await expect(page.getByText("Baseline: 0.2")).toBeVisible();
  // A name can be typed too; an unnamed cell shows with its sheet.
  await page.getByRole("button", { name: "Output", exact: true }).click();
  await page.getByLabel("Output 1", { exact: true }).fill("strike");
  await page.getByLabel("Output 1", { exact: true }).press("Enter");
  await expect(page.getByLabel("Output 1", { exact: true })).toHaveValue("Strike");
  await page.getByRole("button", { name: "Output", exact: true }).click();
  await cell(page, 7, 1).click();
  await expect(page.getByLabel("Output 2", { exact: true })).toHaveValue("'Option pricing'!B8");

  // An alternative is a formula, edited like the formula bar: clicking cells inserts them (by
  // name when named), and they're coloured.
  await page.getByRole("button", { name: "Alternative", exact: true }).click();
  const alternative = page.getByLabel("Alternative 1", { exact: true });
  await alternative.click();
  await page.keyboard.type("=");
  await cell(page, 3, 1).click();
  await page.keyboard.type("*2");
  await expect(alternative).toHaveValue("=Volatility*2");
  await expect(alternative.locator("..").locator('[data-reference="name:volatility"]')).toHaveCount(
    1,
  );
  await alternative.press("Enter");
  await expect(page.getByTestId("combination-count")).toHaveText(/1 combination/);
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

  // Selection and editing use the real row. (The name box shows B2's name, Strike.)
  await cell(page, 0, 1).click();
  await expect(page.getByLabel("Cell address")).toHaveAttribute("data-address", "B2");
  await expect(formulaBar(page)).toHaveValue("105");
  await page.keyboard.press("F2");
  await expect(page.getByLabel("Cell editor")).toHaveValue("105");
  await page.keyboard.press("Escape");

  // Enter moves to the next visible row, never a hidden one.
  await cell(page, 0, 1).click();
  await formulaBar(page).fill("110");
  await formulaBar(page).press("Enter");
  await expect(cell(page, 0, 1)).toHaveText("110");
  const next = (await page.getByLabel("Cell address").getAttribute("data-address")) ?? "";
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
