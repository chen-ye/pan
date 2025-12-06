import { expect, test } from "@playwright/test";

test("homepage has title", async ({ page }) => {
  await page.goto("/");

  // Expect a title "to contain" a substring.
  await expect(page).toHaveTitle(/Pan NVR/);

  // Create a locator for the header
  const header = page.locator("h1");
  await expect(header).toContainText("Pan NVR");
});
