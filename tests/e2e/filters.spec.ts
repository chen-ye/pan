import { expect, test } from "@playwright/test";

test("processed filter triggers api request", async ({ page }) => {
  await page.goto("/");

  // Locate the "Processed Only" checkbox in the visible column (desktop)
  const processedCheckbox = page.locator("#filters-col sl-checkbox", {
    hasText: "Processed Only",
  });
  await processedCheckbox.waitFor();

  // Click it
  await processedCheckbox.click();

  // Verify URL updates to reflect filter state
  await expect(page).toHaveURL(/processed=true/);
});
