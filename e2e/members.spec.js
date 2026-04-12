// E2E: Members page — empty state, page renders without errors
import { test, expect } from '@playwright/test';

test.describe('Members page', () => {
  test('renders Family Members heading', async ({ page }) => {
    await page.goto('/members');
    await expect(page.getByRole('heading', { name: 'Family Members' })).toBeVisible();
  });

  test('shows empty state when no members', async ({ page }) => {
    await page.goto('/members');
    await page.waitForLoadState('networkidle');
    // Either members list or empty state message
    const hasMembers = await page.getByText(/Adults|Kids/).isVisible().catch(() => false);
    if (!hasMembers) {
      await expect(page.getByText('No members registered.')).toBeVisible();
    }
  });

  test('shows notification settings note', async ({ page }) => {
    await page.goto('/members');
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(/\/snooze/)).toBeVisible();
  });

  test('no error state rendered', async ({ page }) => {
    await page.goto('/members');
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(/Error:/i)).not.toBeVisible();
  });

  test('no console errors on load', async ({ page }) => {
    const errors = [];
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    await page.goto('/members');
    await page.waitForLoadState('networkidle');
    expect(errors.filter(e => !e.includes('favicon'))).toHaveLength(0);
  });
});
