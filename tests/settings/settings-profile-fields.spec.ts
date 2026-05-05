// spec: specs/agent-kanban.plan.md
// section: 5.2 Profile settings fields

import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

test.describe("Settings Profile", () => {
  test("shows readonly email and email verification state", async ({ page }) => {
    const email = `settings_profile_fields_${Date.now()}@example.com`;
    await signUpAndGetBoard(page, email);

    await page.goto("/settings/profile");

    const emailInput = page.getByLabel("Email");
    await expect(emailInput).toHaveValue(email);
    await expect(emailInput).not.toBeEditable();
    await expect(page.getByText(/^(Verified|Unverified)$/)).toBeVisible();
  });

  test("does not expose an editable image URL field", async ({ page }) => {
    await signUpAndGetBoard(page, `settings_profile_no_avatar_${Date.now()}@example.com`);

    await page.goto("/settings/profile");

    await expect(page.getByRole("textbox", { name: /(?:image|avatar).*url|url.*(?:image|avatar)/i })).toHaveCount(0);
    await expect(page.getByLabel(/(?:image|avatar).*url|url.*(?:image|avatar)/i)).toHaveCount(0);
  });

  test("still displays the current avatar image when present", async ({ page }) => {
    await signUpAndGetBoard(page, `settings_profile_avatar_${Date.now()}@example.com`);
    const avatarUrl = new URL("/test-avatar.svg", page.url()).toString();

    await page.route("**/test-avatar.svg", async (route) => {
      await route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="#22D3EE"/></svg>',
      });
    });
    await page.evaluate(async (image) => {
      const token = localStorage.getItem("auth-token");
      const res = await fetch("/api/auth/update-user", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ image }),
      });
      if (!res.ok) throw new Error(`Failed to set avatar: ${res.status}`);
    }, avatarUrl);

    await page.goto("/settings/profile");

    await expect(page.locator('main [data-slot="avatar-image"]')).toHaveAttribute("src", avatarUrl);
  });
});
