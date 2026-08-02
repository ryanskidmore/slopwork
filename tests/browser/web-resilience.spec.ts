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

test("review panel load-more fetches and appends the next page", async ({ page }) => {
  const pageOne = {
    config: {
      project: "fixture",
      warning: null,
      remotes: { repo: null, jira: null },
      defaults: { stale_after: "60m", review_stale_after: "24h" },
      integrity: { event_problems: [] },
    },
    tickets: [
      {
        id: "ticket_01LOADMOREPAGEONE00000001",
        handle: "t-lm001",
        name: "Load-more page one ticket",
        slug: "load-more-page-one-ticket",
        state: "review",
        priority: 2,
        labels: [],
        owner: null,
        adhoc: false,
        last_activity_at: "2026-07-20T10:00:00.000Z",
        latest_note: null,
        created_at: "2026-07-20T10:00:00.000Z",
        updated_at: "2026-07-20T10:00:00.000Z",
        parent: { kind: "none" },
        overlay: {
          blocked: false,
          blocked_by: [],
          stale: false,
          stale_reason: null,
          awaiting_input: false,
          awaiting_input_reason: null,
        },
        review: {
          mr: null,
          requested_at: "2026-07-20T10:00:00.000Z",
          by: { name: "reviewer", kind: "human" },
          awaiting_ms: 1_000,
        },
      },
    ],
    pagination: { page: 1, limit: 1, total: 2, total_pages: 2, previous_page: null, next_page: 2 },
  };
  const pageTwo = {
    ...pageOne,
    tickets: [
      {
        ...pageOne.tickets[0],
        id: "ticket_01LOADMOREPAGETWO00000002",
        handle: "t-lm002",
        name: "Load-more page two ticket",
        slug: "load-more-page-two-ticket",
      },
    ],
    pagination: { page: 2, limit: 1, total: 2, total_pages: 2, previous_page: 1, next_page: null },
  };

  await page.route("**/api/review*", async (route) => {
    const url = new URL(route.request().url());
    const body = url.searchParams.get("page") === "2" ? pageTwo : pageOne;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });

  await page.goto("/review");
  await expect(page.getByRole("link", { name: "Load-more page one ticket" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Load-more page two ticket" })).not.toBeVisible();
  await expect(page.getByText("Showing 1 of 2 tickets")).toBeVisible();

  const loadMore = page.getByRole("button", { name: "Load more" });
  await expect(loadMore).toBeVisible();
  await loadMore.click();

  await expect(page.getByRole("link", { name: "Load-more page two ticket" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Load-more page one ticket" })).toBeVisible();
  await expect(page.getByText("Showing 2 of 2 tickets")).toBeVisible();
  await expect(page.getByText("All loaded")).toBeVisible();
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
