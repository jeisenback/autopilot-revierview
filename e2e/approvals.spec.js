// E2E: Approvals page — empty state, page renders without errors
import { test, expect } from '@playwright/test';

test.describe('Approvals page', () => {
  test('renders heading and empty state when no approvals', async ({ page }) => {
    await page.goto('/approvals');
    await expect(page.getByRole('heading', { name: 'Pending Approvals' })).toBeVisible();
    // Empty state icon + message
    await expect(page.getByText('No pending approvals.')).toBeVisible();
  });

  test('no console errors on load', async ({ page }) => {
    const errors = [];
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    await page.goto('/approvals');
    // Wait for data to settle
    await page.waitForLoadState('networkidle');
    expect(errors.filter(e => !e.includes('favicon'))).toHaveLength(0);
  });

  test('no error state rendered', async ({ page }) => {
    await page.goto('/approvals');
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(/Error:/i)).not.toBeVisible();
  });
});
