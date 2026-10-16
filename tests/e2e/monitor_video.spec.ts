import { test } from "@playwright/test";

test("monitor video requests on detail view", async ({ page }) => {
  let videoReqCount = 0;
  const videoRanges: string[] = [];

  page.on("request", (req) => {
    if (req.url().includes("/videos/")) {
      videoReqCount++;
      videoRanges.push(req.headers()["range"] || "no-range");
    }
  });

  const target = "/?video=NVR-unknown%2FBackyard%2F2026%2F07%2F19%2FBackyard_00_20260719134343.mp4";
  console.log("Navigating to", target);
  await page.goto(target);

  // Wait 10 seconds to see how many requests fire
  await page.waitForTimeout(10000);

  console.log(`TOTAL VIDEO REQUESTS in 10s: ${videoReqCount}`);
  console.log("First 10 ranges:", videoRanges.slice(0, 10));
  if (videoRanges.length > 10) {
    console.log("Last 5 ranges:", videoRanges.slice(-5));
  }
});
