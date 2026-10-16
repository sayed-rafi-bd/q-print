import { test } from '@playwright/test';
import { createLabel, designerReady, signUp } from './helpers';

/**
 * Not a test: captures the Designer as it looks, so the UI can be judged from what is actually
 * rendered rather than from reading the JSX. Run with `npx playwright test e2e/shots.e2e.ts`.
 */
test('capture the designer', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signUp(page);
  await createLabel(page, { name: 'Parcel', from: 'sample' });
  await designerReady(page);
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'shots/02-layout-sample.png' });

  await page.getByRole('tab', { name: 'Data' }).click();
  await page.screenshot({ path: 'shots/03-data.png' });

  const note = page.locator('details').filter({ has: page.locator('code', { hasText: /^note$/ }) });
  await note.locator('summary').click();
  await page.screenshot({ path: 'shots/04-rule-editor.png' });

  await page.getByText('Test with a real API').click();
  await page.screenshot({ path: 'shots/05-api-panel.png' });

  // A phone, which is what this app is printed from.
  await page.setViewportSize({ width: 400, height: 820 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: 'shots/10-phone-layout.png', fullPage: false });

  await page.getByRole('tab', { name: 'Data' }).click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: 'shots/11-phone-data.png', fullPage: false });

  const note2 = page.locator('details').filter({ has: page.locator('code', { hasText: /^note$/ }) });
  await note2.locator('summary').click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: 'shots/12-phone-rule.png', fullPage: false });
});
