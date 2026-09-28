import { test } from "@playwright/test";

test("zzshot", async ({ page }) => {
  await page.goto("/");
  await page.waitForTimeout(500);
  await page.screenshot({
    path: "C:/Users/james/.claude/jobs/4c1b37b1/tmp/vtabs.png",
    clip: { x: 0, y: 110, width: 260, height: 200 },
  });
});
