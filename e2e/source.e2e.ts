import { expect, type Page, test } from '@playwright/test';
import { createLabel, designerReady, signUp, tabButton, watchErrors } from './helpers';

/**
 * The API data source in the web build's Designer. The API is mocked with `page.route`, so no real
 * network is used. A browser enforces CORS, so the mock answers with the header the real server
 * would have to send. Printing needs the desktop app, so these tests stop at the Designer.
 */
const API = 'https://api.e2e.test/**';
const JSON_HEADERS = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
const RECORDS = [
  { title: 'Alpha', code: 'A-1' },
  { title: 'Beta', code: 'B-2' },
];

const saveButton = (page: Page) => page.getByRole('button', { name: 'Save', exact: true });

test.describe('designer: API data source', () => {
  test('build it, fetch a sample, map a field, save, and find it again after a reload', async ({ page }) => {
    const errors = watchErrors(page);
    const requested: string[] = [];
    await page.route(API, (route) => {
      requested.push(route.request().url());
      return route.fulfill({ status: 200, headers: JSON_HEADERS, body: JSON.stringify(RECORDS) });
    });

    await signUp(page);
    await createLabel(page, { name: 'Api label', from: 'sample' });
    await expect(page.getByLabel('Label', { exact: true })).toHaveValue(/api-label/);

    // Turn the data source on and describe it.
    await tabButton(page, 'Source').click();
    await page.getByRole('button', { name: 'Use an API as the data source' }).click();
    await page.getByLabel('URL pattern').fill('api.e2e.test/items/{id}');

    // Fetch one sample with a value for the variable.
    const test_ = page.getByRole('region', { name: 'Test' });
    await test_.getByLabel('id', { exact: true }).fill('42');
    await test_.getByRole('button', { name: 'Fetch sample' }).click();
    await expect(test_.getByRole('status')).toContainText('2 records found');
    expect(requested).toEqual(['https://api.e2e.test/items/42']);
    await expect(test_.getByText('title', { exact: true })).toBeVisible(); // a path offered from the sample

    // Map a field to a path in the response; its live sample shows the real value. `note` is one of
    // the sample label's own fields.
    await tabButton(page, 'Data').click();
    await page.getByRole('button', { name: 'Fields', exact: true }).click();
    const note = page.locator('details').filter({ has: page.locator('code', { hasText: /^note$/ }) });
    await note.locator('summary').click();
    await note.getByLabel('Rule').selectOption('api');
    await note.getByLabel('Path in the API record').fill('title');
    await expect(note.locator('summary')).toContainText('Alpha');

    // Save, reload, and the source is still there. The sample and any token are not.
    await saveButton(page).click();
    await expect(page.getByText('Saved. This label is on your account.')).toBeVisible();
    await page.reload();
    await designerReady(page);
    await tabButton(page, 'Source').click();
    await expect(page.getByLabel('URL pattern')).toHaveValue('api.e2e.test/items/{id}');
    await expect(page.getByRole('status')).toHaveCount(0);

    expect(errors).toEqual([]);
  });

  test('shows a server error with advice, without losing the form', async ({ page }) => {
    await page.route(API, (route) =>
      route.fulfill({ status: 401, headers: JSON_HEADERS, body: JSON.stringify({ error: 'bad token' }) }),
    );
    await signUp(page);
    await createLabel(page, { name: 'Api error', from: 'sample' });
    await tabButton(page, 'Source').click();
    await page.getByRole('button', { name: 'Use an API as the data source' }).click();
    await page.getByLabel('URL pattern').fill('api.e2e.test/secure');
    await page.getByLabel('Use a bearer token').check();

    const test_ = page.getByRole('region', { name: 'Test' });
    await test_.getByLabel('Access token').fill('wrong-token');
    await test_.getByRole('button', { name: 'Fetch sample' }).click();

    const alert = test_.getByRole('alert');
    await expect(alert).toContainText('HTTP 401');
    await expect(alert).toContainText('Check the access token.');
    await expect(page.locator('body')).not.toContainText('wrong-token');
    await expect(test_.getByLabel('Access token')).toHaveValue(''); // cleared after the request
    await expect(page.getByLabel('URL pattern')).toHaveValue('api.e2e.test/secure');
  });

  test('a bad address is reported and blocks Save', async ({ page }) => {
    await signUp(page);
    await createLabel(page, { name: 'Api bad url', from: 'sample' });
    await tabButton(page, 'Source').click();
    await page.getByRole('button', { name: 'Use an API as the data source' }).click();
    await page.getByLabel('URL pattern').fill('ftp://api.e2e.test/{id}');

    await expect(page.getByText(/Only http and https/).first()).toBeVisible();
    await expect(saveButton(page)).toBeDisabled();

    await page.getByLabel('URL pattern').fill('api.e2e.test/{id}');
    await expect(page.getByText(/Only http and https/)).toHaveCount(0);
  });
});
