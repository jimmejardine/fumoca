import { expect, test } from "@playwright/test";

test("app loads with a grid", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "fumoca" })).toBeVisible();
  await expect(page.locator("revo-grid")).toBeVisible();
});
