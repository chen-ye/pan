import { describe, expect, it } from "vitest";
import { formatSize } from "../../frontend/src/components/video-list.ts";

describe("formatSize", () => {
  it("formats bytes correctly", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(1024)).toBe("1 KB");
    expect(formatSize(1024 * 1024)).toBe("1 MB");
    expect(formatSize(1500)).toBe("1.5 KB");
  });
});
