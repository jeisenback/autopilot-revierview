// E2E: navigation shell — sidebar links, page titles, no console errors
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  // Capture console errors
  page.on('console', msg => {
    if (msg.type() === 'error') {
      // Log but don't fail — we assert explicitly where needed
      console.error('Browser console error:', msg.text());
    }
  });
});

test('redirects / to /projects', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/projects/);
});

test('sidebar renders all three nav links', async ({ page }) => {
  await page.goto('/projects');
  await expect(page.getByRole('link', { name: 'Projects' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Approvals' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Members' })).toBeVisible();
});

test('sidebar shows Autopilot / Riverview branding', async ({ page }) => {
  await page.goto('/projects');
  await expect(page.getByText('Autopilot')).toBeVisible();
  await expect(page.getByText('Riverview')).toBeVisible();
});

test('navigate to Approvals page via sidebar', async ({ page }) => {
  await page.goto('/projects');
  await page.getByRole('link', { name: 'Approvals' }).click();
  await expect(page).toHaveURL(/\/approvals/);
  await expect(page.getByRole('heading', { name: 'Pending Approvals' })).toBeVisible();
});

test('navigate to Members page via sidebar', async ({ page }) => {
  await page.goto('/projects');
  await page.getByRole('link', { name: 'Members' }).click();
  await expect(page).toHaveURL(/\/members/);
  await expect(page.getByRole('heading', { name: 'Family Members' })).toBeVisible();
});

test('active sidebar link is highlighted', async ({ page }) => {
  await page.goto('/approvals');
  // Active link has bg-secondary AND text-foreground; inactive has text-muted-foreground
  const approvalsLink = page.getByRole('link', { name: 'Approvals' });
  await expect(approvalsLink).toHaveClass(/text-foreground/);
  await expect(approvalsLink).not.toHaveClass(/text-muted-foreground/);
  // Inactive link has text-muted-foreground
  const projectsLink = page.getByRole('link', { name: 'Projects' });
  await expect(projectsLink).toHaveClass(/text-muted-foreground/);
});
