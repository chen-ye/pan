import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["unit/**/*.{test,spec}.{js,ts}"],
    root: ".",
  },
});
