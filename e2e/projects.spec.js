// E2E: Projects Kanban board — load, create, navigate to detail
import { test, expect } from '@playwright/test';

test.describe('Projects page', () => {
  test('loads and shows Kanban columns', async ({ page }) => {
    await page.goto('/projects');
    // Four status columns
    await expect(page.getByText('Open')).toBeVisible();
    await expect(page.getByText('Active')).toBeVisible();
    await expect(page.getByText('Blocked')).toBeVisible();
    await expect(page.getByText('Done')).toBeVisible();
  });

  test('New Project button is visible', async ({ page }) => {
    await page.goto('/projects');
    await expect(page.getByRole('button', { name: /New Project/i })).toBeVisible();
  });

  test('opens New Project dialog on button click', async ({ page }) => {
    await page.goto('/projects');
    await page.getByRole('button', { name: /New Project/i }).click();
    // Dialog should appear
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('textbox')).toBeVisible();
  });

  test('dialog closes on Cancel', async ({ page }) => {
    await page.goto('/projects');
    await page.getByRole('button', { name: /New Project/i }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: /Cancel/i }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
  });

  test('create a project and see it in Kanban', async ({ page }) => {
    await page.goto('/projects');
    await page.getByRole('button', { name: /New Project/i }).click();

    const title = `E2E Test Project ${Date.now()}`;
    await page.getByRole('textbox').fill(title);
    await page.getByRole('button', { name: /^Create$|^Add$|^Save$/i }).click();

    // Dialog should close
    await expect(page.getByRole('dialog')).not.toBeVisible();
    // Project card should appear — Claude decompose runs async, just wait for title
    await expect(page.getByText(title)).toBeVisible({ timeout: 15000 });
  });

  test('clicking a project card navigates to detail', async ({ page }) => {
    // Create a project first so there is something to click
    await page.goto('/projects');
    await page.getByRole('button', { name: /New Project/i }).click();
    const title = `Nav Test ${Date.now()}`;
    await page.getByRole('textbox').fill(title);
    await page.getByRole('button', { name: /^Create$|^Add$|^Save$/i }).click();
    await expect(page.getByText(title)).toBeVisible({ timeout: 15000 });

    // Click the card
    await page.getByText(title).click();
    await expect(page).toHaveURL(/\/projects\/\d+/);
  });

  test('empty state: Open column shows 0 badge when no open projects', async ({ page }) => {
    // We can't guarantee zero projects, but we can verify badge renders
    await page.goto('/projects');
    // Each column header should show a count badge (even if 0)
    const badges = page.locator('h2 ~ span');
    // At least 4 column headers with count badges
    await expect(badges).toHaveCount(4, { timeout: 5000 });
  });
});
