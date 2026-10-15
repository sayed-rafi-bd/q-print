import { expect, type Page } from '@playwright/test';

/** Errors the page throws or logs; every test checks this stays empty. */
export function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  return errors;
}

export const uniqueName = (prefix = 'user') => `${prefix}${Date.now()}${Math.floor(Math.random() * 1000)}`;

/** Creates a fresh account through the real sign-up form and waits for the Designer. */
export async function signUp(page: Page, username = uniqueName(), password = 'secret1') {
  await page.goto('/');
  await page.getByRole('button', { name: 'Need an account? Sign up' }).click();
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await designerReady(page);
  return { username, password };
}

export async function signIn(page: Page, username: string, password: string) {
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await designerReady(page);
}

export const canvas = (page: Page) => page.getByTestId('designer-canvas');

/** The designer is up when the label picker is usable and pdfme has drawn its field list. */
export async function designerReady(page: Page) {
  await expect(page.getByLabel('Label', { exact: true })).toBeEnabled();
  await expect(canvas(page).getByText('Field List')).toBeVisible();
}

/** pdfme has really painted: its container is visible, has a size and contains its UI. */
export async function expectCanvasPainted(page: Page) {
  await expect(canvas(page)).toBeVisible();
  const box = await canvas(page).boundingBox();
  expect(box && box.width > 300 && box.height > 200, `designer canvas was ${JSON.stringify(box)}`).toBe(true);
  await expect(canvas(page).getByText('Field List')).toBeVisible();
}

export const tabButton = (page: Page, name: 'Layout' | 'Source' | 'Data') =>
  page.getByRole('button', { name: new RegExp(`^${name}`) });

/** Creates a label from the "New" dialog. */
export async function createLabel(
  page: Page,
  opts: { name: string; from?: 'blank' | 'sample' | RegExp; size?: [number, number] },
) {
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const dialog = page.locator('form').filter({ hasText: 'Start from' });
  // Choosing a starting point resets the name and size, so pick it first and fill the rest after.
  const from = opts.from ?? 'blank';
  if (from === 'blank') await dialog.getByRole('radio', { name: /A blank label/ }).check();
  else if (from === 'sample') await dialog.getByRole('radio', { name: /The sample label/ }).check();
  else await dialog.getByRole('radio', { name: from }).check();
  await dialog.getByLabel('Name', { exact: true }).fill(opts.name);
  if (opts.size) {
    await dialog.getByLabel('Width in mm').fill(String(opts.size[0]));
    await dialog.getByLabel('Height in mm').fill(String(opts.size[1]));
  }
  await dialog.getByRole('button', { name: 'Create label' }).click();
}
