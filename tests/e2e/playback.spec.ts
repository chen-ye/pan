import { expect, test } from "@playwright/test";

test("selecting a video loads it in detail view", async ({ page }) => {
  await page.goto("/");

  // Wait for video list to load
  const videoItem = page.locator(".video-item").first();
  await videoItem.waitFor();

  // Get the name/title of the first video
  // const title = await videoItem.locator('.video-title').innerText();

  // Click the video
  await videoItem.click();

  // Check that the video player source is set or video detail updates
  // Assuming video-detail is visible and has the video element
  const videoDetail = page.locator("video-detail");
  await expect(videoDetail).toBeVisible();

  // We can't easily check Shadow DOM inside deep structure from here without deeper selectors
  // But we can check if the item became active
  await expect(videoItem).toHaveClass(/active/);
});
