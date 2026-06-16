import { test } from "@playwright/test";

const baseURL = `http://localhost:${process.env.VITE_DEV_PORT || 6265}`;

test.describe("Agent Kanban", () => {
  test("seed", async ({ page }) => {
    await page.goto(baseURL);
  });
});
