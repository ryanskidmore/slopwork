/// <reference lib="dom" />

import { expect, test } from "@playwright/test";

test("desktop tree renders nonblank, collapses accessibly, and persists expansion", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/tree");

  await expect(page.getByRole("heading", { name: "Tree" })).toBeVisible();
  await expect(page.getByRole("tree", { name: "Ticket hierarchy" })).toBeVisible();
  const screenshot = await page.screenshot({ fullPage: true });
  expect(screenshot.byteLength).toBeGreaterThan(15_000);
  await expect(page).toHaveScreenshot("tree-desktop.png", {
    fullPage: true,
    animations: "disabled",
  });

  const collapsedItem = page.locator('[role="treeitem"][aria-expanded="false"]').first();
  await expect(collapsedItem).toBeVisible();
  const toggle = collapsedItem.getByRole("button", {
    name: /^Expand children of /,
  });
  const toggleName = await toggle.getAttribute("aria-label");
  expect(toggleName).toBeTruthy();
  const expandedToggleName = toggleName?.replace(/^Expand /, "Collapse ") ?? "";
  await toggle.focus();
  await page.keyboard.press("Enter");
  const expandedToggle = page.getByRole("button", { name: expandedToggleName });
  await expect(expandedToggle).toBeVisible();
  await expect(expandedToggle.locator('xpath=ancestor::li[@role="treeitem"][1]')).toHaveAttribute(
    "aria-expanded",
    "true",
  );

  await page.reload();
  const persistedToggle = page.getByRole("button", {
    name: expandedToggleName,
  });
  await expect(persistedToggle).toBeVisible();
  await expect(persistedToggle.locator('xpath=ancestor::li[@role="treeitem"][1]')).toHaveAttribute(
    "aria-expanded",
    "true",
  );

  await page.getByRole("button", { name: "Collapse all branches" }).click();
  await expect(page.locator('[role="treeitem"][aria-expanded="true"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Expand all branches" }).click();
  await expect(page.locator('[role="treeitem"][aria-expanded="false"]')).toHaveCount(0);
});

test("failed review fetch reaches retry and recovers", async ({ page }) => {
  let attempts = 0;
  await page.route("**/api/review", async (route) => {
    attempts += 1;
    if (attempts === 1) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "simulated read failure" }),
      });
      return;
    }
    await route.continue();
  });

  await page.goto("/review");
  const alert = page.getByRole("alert").filter({ hasText: "Review queue unavailable" });
  await expect(alert).toContainText("simulated read failure");
  await alert.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText(/ticket.*awaiting review/)).toBeVisible();
  expect(attempts).toBe(2);
});

test("mobile navigation keeps names, keyboard operation, and coherent layout", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/tree");

  const navigation = page.getByRole("navigation", { name: "Main" });
  await expect(navigation).toBeVisible();
  for (const name of ["Tickets", "Tree", "Review", "Questions", "Stale"]) {
    await expect(navigation.getByRole("link", { name, exact: true })).toBeVisible();
  }

  const treeToggle = page.getByRole("button", { name: /^(Expand|Collapse) children of / }).first();
  const treeItem = treeToggle.locator('xpath=ancestor::li[@role="treeitem"][1]');
  const before = await treeItem.getAttribute("aria-expanded");
  await treeToggle.focus();
  await page.keyboard.press("Enter");
  await expect(treeItem).toHaveAttribute("aria-expanded", before === "true" ? "false" : "true");

  const layout = await page.evaluate(() => {
    const header = document.querySelector("header");
    const nav = document.querySelector('nav[aria-label="Main"]');
    const headerRect = header?.getBoundingClientRect();
    const navRect = nav?.getBoundingClientRect();
    const unnamed = [...document.querySelectorAll("a, button")].filter((element) => {
      const text = element.textContent?.trim() ?? "";
      return !text && !element.getAttribute("aria-label") && !element.getAttribute("title");
    }).length;
    return {
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
      headerWidth: headerRect?.width ?? 0,
      navWidth: navRect?.width ?? 0,
      unnamed,
    };
  });
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.headerWidth).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.navWidth).toBeGreaterThan(300);
  expect(layout.unnamed).toBe(0);

  const screenshot = await page.screenshot({ fullPage: true });
  expect(screenshot.byteLength).toBeGreaterThan(12_000);
  await expect(page).toHaveScreenshot("tree-mobile.png", {
    fullPage: true,
    animations: "disabled",
  });
});
