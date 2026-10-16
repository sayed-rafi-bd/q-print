import { expect, type Page, test } from '@playwright/test';
import { signUp, watchErrors } from './helpers';

/**
 * The History tab: what has been printed from this device.
 *
 * Runs as a web page because that is where the tab is visible without a printer — the web build
 * cannot print, so the entries are seeded straight into the same `localStorage` key the Print tab
 * writes to. What is checked here is what unit tests cannot: that the page reads the real key, that
 * grouping and the counts reach the screen, and that Clear actually empties the store rather than
 * only the list.
 */

const openHistory = (page: Page) => page.getByRole('button', { name: /History/ }).click();

/**
 * The entries under one day heading.
 *
 * Scoped deliberately: every tab stays mounted and hidden with `visibility: hidden`, so a bare
 * `li` also matches the Designer's and this would pick up the wrong list entirely.
 */
const entriesOn = (page: Page, day: string) => page.locator(`section[aria-label="${day}"] li`);

/** Puts a spread of entries in the store: two days, both outcomes, an API label, a dialog print. */
async function seed(page: Page) {
  await page.evaluate(() => {
    const now = Date.now();
    const day = 86_400_000;
    localStorage.setItem(
      `q-print.history.${localStorage.getItem('q-print.userId')}`,
      JSON.stringify([
        {
          at: now - 60_000,
          labelId: 'lbl_product',
          labelName: 'Product label',
          printer: 'Warehouse ZPL',
          outcome: 'ok',
          pages: 24,
          records: 8,
          transport: 'sumatra',
          error: null,
          ms: 1840,
        },
        {
          at: now - 5 * 60_000,
          labelId: 'lbl_ship',
          labelName: 'Shipping label',
          // Empty means the system dialog was used, where no printer has been chosen yet.
          printer: '',
          outcome: 'ok',
          pages: 1,
          records: null,
          transport: 'cups',
          error: null,
          ms: 640,
        },
        {
          at: now - 40 * 60_000,
          labelId: 'lbl_product',
          labelName: 'Product label',
          printer: 'Front desk',
          outcome: 'error',
          pages: null,
          records: null,
          transport: null,
          error: 'The printer at Front desk did not answer.',
          ms: 15_200,
        },
        {
          at: now - day,
          labelId: 'lbl_asset',
          labelName: 'Asset tag',
          printer: 'Label printer 2',
          outcome: 'ok',
          pages: 120,
          records: 120,
          transport: 'ipp',
          error: null,
          ms: 12_400,
        },
      ]),
    );
  });
}

test.describe('history', () => {
  test('says so when nothing has been printed', async ({ page }) => {
    const errors = watchErrors(page);
    await signUp(page);
    await openHistory(page);

    await expect(page.getByRole('heading', { name: 'Print history' })).toBeVisible();
    await expect(page.getByText('Nothing printed yet.')).toBeVisible();
    // Nothing to delete, so no Clear button sitting there doing nothing.
    await expect(page.getByRole('button', { name: 'Clear history' })).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('lists what was printed, grouped by day, newest first', async ({ page }) => {
    const errors = watchErrors(page);
    await signUp(page);
    await seed(page);
    await openHistory(page);

    await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Yesterday' })).toBeVisible();

    // Newest first inside the day: the 1-minute-old entry precedes the 40-minute-old one.
    const today = entriesOn(page, 'Today');
    await expect(today.nth(0)).toContainText('Product label');
    await expect(today.nth(0)).toContainText('24 pages');
    await expect(today.nth(0)).toContainText('Warehouse ZPL');
    await expect(today.nth(1)).toContainText('Shipping label');
    // The older entry is under Yesterday, not Today.
    await expect(page.locator('section[aria-label="Yesterday"] li')).toHaveCount(1);
    expect(errors).toEqual([]);
  });

  test('counts one page as one page', async ({ page }) => {
    const errors = watchErrors(page);
    await signUp(page);
    await seed(page);
    await openHistory(page);

    // "1 pages" was what this showed before. Caught by eye, so it is pinned here instead.
    await expect(page.getByText('1 page', { exact: true })).toBeVisible();
    await expect(page.getByText('1 pages', { exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('keeps a failure visible, with what went wrong', async ({ page }) => {
    const errors = watchErrors(page);
    await signUp(page);
    await seed(page);
    await openHistory(page);

    const failed = entriesOn(page, 'Today').filter({ hasText: 'The printer at Front desk did not answer.' });
    await expect(failed).toHaveCount(1);
    await expect(failed).toContainText('Failed');
    // A failed print sent nothing, so it must not claim a page count.
    await expect(failed).not.toContainText('pages');
    expect(errors).toEqual([]);
  });

  test('names the system print dialog when no printer was chosen', async ({ page }) => {
    const errors = watchErrors(page);
    await signUp(page);
    await seed(page);
    await openHistory(page);

    await expect(page.getByText('the system print dialog')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('shows what is stored even when it has been damaged', async ({ page }) => {
    const errors = watchErrors(page);
    await signUp(page);
    await seed(page);
    // One good entry among rubbish. The page has to open and show the good one rather than
    // refusing to render, which is what happens if the whole list is parsed as one unit.
    await page.evaluate(() => {
      const key = `q-print.history.${localStorage.getItem('q-print.userId')}`;
      const good = JSON.parse(localStorage.getItem(key) ?? '[]')[0];
      localStorage.setItem(key, JSON.stringify([good, { nonsense: true }, 'not an object']));
    });
    await openHistory(page);

    await expect(page.getByText('24 pages')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('Clear empties the store, not just the list', async ({ page }) => {
    const errors = watchErrors(page);
    await signUp(page);
    await seed(page);
    await openHistory(page);

    await page.getByRole('button', { name: 'Clear history' }).click();
    // Two steps, because the store is the only copy and there is no undo.
    await expect(page.getByText('Delete all 4?')).toBeVisible();
    await page.getByRole('button', { name: 'Keep' }).click();
    await expect(page.getByText('24 pages')).toBeVisible();

    await page.getByRole('button', { name: 'Clear history' }).click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();

    await expect(page.getByText('Nothing printed yet.')).toBeVisible();
    // The list could have been emptied locally; what matters is that the store is empty too, or the
    // entries would come back on the next visit.
    await expect
      .poll(() =>
        page.evaluate(() => localStorage.getItem(`q-print.history.${localStorage.getItem('q-print.userId')}`)),
      )
      .toBeNull();
    expect(errors).toEqual([]);
  });

  test('one account does not see another account history', async ({ page }) => {
    const errors = watchErrors(page);
    await signUp(page);
    await seed(page);
    await openHistory(page);
    await expect(page.getByText('24 pages')).toBeVisible();

    await page.getByRole('button', { name: 'Sign out' }).click();
    // A second account, not the first one again: signing back into the same account must of course
    // still show that account's own history.
    await signUp(page);

    // The seeded key was written under the first account's id, so this one must read nothing.
    await openHistory(page);
    await expect(page.getByText('Nothing printed yet.')).toBeVisible();
    expect(errors).toEqual([]);
  });
});
