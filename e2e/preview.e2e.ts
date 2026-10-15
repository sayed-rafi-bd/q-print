import { expect, type Page, test } from '@playwright/test';
import { createLabel, designerReady, signUp, tabButton, watchErrors } from './helpers';

/**
 * Placeholder values typed while designing, kept in the database so the preview looks the same the
 * next time the label is opened. Design-time only, so nothing here reaches a print job.
 *
 * The built-in label is in here because it has no row in `labels` at all: its layout is on the
 * device and its generator ships in the app, yet it needs placeholders just as much.
 */

const saveButton = (page: Page) => page.getByRole('button', { name: 'Save', exact: true });

/** The Data tab, where each field has a "Preview value" box. */
async function dataTab(page: Page) {
  await tabButton(page, 'Data').click();
  await page.getByRole('button', { name: 'Fields', exact: true }).click();
}

/** Opens a field's row in the Data tab. */
const fieldRow = (page: Page, name: string) =>
  page.locator('details').filter({ has: page.locator('code', { hasText: new RegExp(`^${name}$`) }) });

test.describe('designer: preview placeholders', () => {
  test('a typed value is saved with the label and is still there after a reload', async ({ page }) => {
    const errors = watchErrors(page);
    await signUp(page);
    await createLabel(page, { name: 'Placeholder', from: 'sample' });
    await dataTab(page);

    const row = fieldRow(page, 'note');
    await row.locator('summary').click();
    await row.getByLabel('Preview value for note').fill('My widget');

    // A placeholder is a real edit, so Save turns on and the discard prompt will ask.
    await expect(saveButton(page)).toBeEnabled();
    await saveButton(page).click();
    await expect(page.getByText('Saved. This label is on your account.')).toBeVisible();

    await page.reload();
    await designerReady(page);
    await dataTab(page);
    await expect(fieldRow(page, 'note').getByLabel('Preview value for note')).toHaveValue('My widget');
    expect(errors).toEqual([]);
  });

  test('the preview says when it is using a placeholder value', async ({ page }) => {
    await signUp(page);
    await createLabel(page, { name: 'Placeholder preview', from: 'sample' });
    await dataTab(page);
    const row = fieldRow(page, 'note');
    await row.locator('summary').click();
    await row.getByLabel('Preview value for note').fill('My widget');

    await page.getByRole('button', { name: 'Preview label' }).click();
    await expect(page.getByRole('dialog', { name: 'Label preview' })).toContainText(
      'your placeholder value in 1 field(s)',
    );
  });

  test('Fill with placeholders gives every field one, and Clear removes them', async ({ page }) => {
    await signUp(page);
    await createLabel(page, { name: 'Placeholder fill', from: 'sample' });
    await dataTab(page);

    await page.getByRole('button', { name: 'Fill with placeholders' }).click();
    // The sample label has these fields; each now has a value to preview with.
    await expect(fieldRow(page, 'note').getByLabel('Preview value for note')).not.toHaveValue('');
    await expect(fieldRow(page, 'itemCode').getByLabel('Preview value for itemCode')).not.toHaveValue('');

    await page.getByRole('button', { name: 'Clear placeholders' }).click();
    await expect(fieldRow(page, 'note').getByLabel('Preview value for note')).toHaveValue('');
    await expect(page.getByRole('button', { name: 'Clear placeholders' })).toBeDisabled();
  });

  test('a built-in label keeps placeholders too, though its rules stay read-only', async ({ page }) => {
    const errors = watchErrors(page);
    await signUp(page);

    await page.getByLabel('Label', { exact: true }).selectOption({ label: 'Product label' });
    await dataTab(page);

    // The rules are the app's own and cannot be edited, but a placeholder is this account's own.
    await expect(page.getByText('This is a built-in label')).toBeVisible();
    const row = fieldRow(page, 'productName');
    await row.locator('summary').click();
    await row.getByLabel('Preview value for productName').fill('Sample product');
    await saveButton(page).click();

    await page.reload();
    await designerReady(page);
    await dataTab(page);
    await expect(fieldRow(page, 'productName').getByLabel('Preview value for productName')).toHaveValue(
      'Sample product',
    );
    expect(errors).toEqual([]);
  });

  test('a duplicated label starts from the placeholders of the one it came from', async ({ page }) => {
    await signUp(page);
    await createLabel(page, { name: 'Placeholder copy', from: 'sample' });
    await dataTab(page);
    const row = fieldRow(page, 'note');
    await row.locator('summary').click();
    await row.getByLabel('Preview value for note').fill('Copy me');
    await saveButton(page).click();

    await page.getByRole('button', { name: 'Duplicate' }).click();
    await page.getByLabel('Label', { exact: true }).selectOption({ index: 1 });
    await dataTab(page);
    await expect(fieldRow(page, 'note').getByLabel('Preview value for note')).toHaveValue('Copy me');
  });
});
