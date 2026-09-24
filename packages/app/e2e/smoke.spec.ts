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

async function editCell(page: Page, row: number, col: number, text: string) {
  await cell(page, row, col).dblclick();
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
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
  const group = await page.locator(".dv-groupview").first().boundingBox();
  if (!group) throw new Error("No tab group");

  // Drag the Functions tab to the right edge to split the area.
  await tabs(page).filter({ hasText: "Functions" }).hover();
  await page.mouse.down();
  await page.mouse.move(group.x + group.width - 40, group.y + group.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect(page.locator(".dv-groupview")).toHaveCount(2);

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
