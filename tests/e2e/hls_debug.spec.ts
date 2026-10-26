import { test, expect } from "@playwright/test";

test.use({
  baseURL: "http://nginx:80",
  ignoreHTTPSErrors: true,
});

test("debug video playback and Hls.js", async ({ page }) => {
  const consoleMessages: string[] = [];
  const networkResponses: string[] = [];

  page.on("console", (msg) => {
    const text = `[CONSOLE ${msg.type()}]: ${msg.text()}`;
    console.log(text);
    consoleMessages.push(text);
  });

  page.on("pageerror", (err) => {
    console.error(`[PAGE ERROR]: ${err.message}`);
  });

  page.on("response", (res) => {
    const url = res.url();
    if (url.includes("video") || url.includes("m3u8") || res.status() >= 400) {
      const info = `[HTTP ${res.status()} ${res.request().method()}]: ${url}`;
      console.log(info);
      networkResponses.push(info);
    }
  });

  console.log("Navigating to test video...");
  await page.goto("/?video=NVR-unknown%2FBackyard%2F2026%2F06%2F18%2FBackyard_00_20260618122217.mp4", {
    waitUntil: "domcontentloaded",
  });

  await page.waitForTimeout(4000);

  // Trigger seek to 10 seconds
  console.log("Seeking to 10s...");
  await page.evaluate(() => {
    const app = document.querySelector("app-root");
    const vd = app?.shadowRoot?.querySelector("video-detail") as any;
    if (vd?.seekToTimestamp) {
      vd.seekToTimestamp(10);
    }
  });

  await page.waitForTimeout(4000);

  const videoStats = await page.evaluate(() => {
    const app = document.querySelector("app-root");
    const vd = app?.shadowRoot?.querySelector("video-detail");
    if (!vd) return { error: "no video-detail found in app-root shadowRoot" };
    const video = vd.shadowRoot?.querySelector("video") as HTMLVideoElement | null;
    if (!video) return { error: "no video in video-detail shadowRoot" };
    return {
      src: video.src,
      currentSrc: video.currentSrc,
      currentTime: video.currentTime,
      duration: video.duration,
      paused: video.paused,
      ended: video.ended,
      readyState: video.readyState,
      networkState: video.networkState,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      error: video.error ? { code: video.error.code, message: video.error.message } : null,
    };
  });

  console.log("=== CODEC SUPPORT ===");
  const codecSupport = await page.evaluate(() => {
    return {
      mse_hvc1: MediaSource.isTypeSupported('video/mp4; codecs="hvc1"'),
      mse_hvc1_sample: MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L150"'),
      mse_hvc1_sample_b: MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L120.90"'),
      mse_hev1: MediaSource.isTypeSupported('video/mp4; codecs="hev1"'),
      mse_avc: MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E"'),
      canPlay_hvc1: document.createElement("video").canPlayType('video/mp4; codecs="hvc1"'),
      canPlay_hev1: document.createElement("video").canPlayType('video/mp4; codecs="hev1"'),
      canPlay_mp4: document.createElement("video").canPlayType('video/mp4'),
    };
  });
  console.log(JSON.stringify(codecSupport, null, 2));

  console.log("=== VIDEO ELEMENT STATS ===");
  console.log(JSON.stringify(videoStats, null, 2));

  expect(videoStats).toBeDefined();
});
