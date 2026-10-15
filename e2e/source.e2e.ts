import { expect, type Page, test } from '@playwright/test';
import { createLabel, designerReady, signUp, tabButton, watchErrors } from './helpers';

/**
 * Testing a label against a real API while designing. The API is mocked with `page.route`, so no
 * real network is used. A browser enforces CORS, so the mock answers with the header a real server
 * would have to send. Printing needs the desktop app, so these tests stop at the Designer.
 *
 * The point of these is that the address belongs to the person, not the label: what a label keeps
 * is the path each field reads, and nothing more.
 */
const API = 'https://api.e2e.test/**';
const JSON_HEADERS = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
const RECORDS = [
  { title: 'Alpha', code: 'A-1' },
  { title: 'Beta', code: 'B-2' },
];

const saveButton = (page: Page) => page.getByRole('button', { name: 'Save', exact: true });
const dataTab = (page: Page) => tabButton(page, 'Data').click();

/** The "Test with a real API" panel, in the Data tab. Opened if it is folded away. */
function testApi(page: Page) {
  return page.getByRole('region', { name: 'Data source' });
}

/** Opens the panel if needed, then returns it. */
async function openTestApi(page: Page) {
  const panel = testApi(page);
  if ((await panel.count()) === 0) await page.getByText('Test with a real API').click();
  return panel;
}

/** One field's row in the Data tab. */
const fieldRow = (page: Page, name: string) =>
  page.locator('details').filter({ has: page.locator('code', { hasText: new RegExp(`^${name}$`) }) });

test.describe('designer: testing against a real API', () => {
  test('fetch a sample, map a field to it, and save only the mapping', async ({ page }) => {
    const errors = watchErrors(page);
    const requested: string[] = [];
    await page.route(API, (route) => {
      requested.push(route.request().url());
      return route.fulfill({ status: 200, headers: JSON_HEADERS, body: JSON.stringify(RECORDS) });
    });

    await signUp(page);
    await createLabel(page, { name: 'Api label', from: 'sample' });
    await expect(page.getByLabel('Label', { exact: true })).toHaveValue(/api-label/);

    // Give an address to test against. It is not part of the label.
    await dataTab(page);
    await page.getByRole('button', { name: 'Fields', exact: true }).click();
    const api = await openTestApi(page);
    await api.getByLabel('Address').fill('api.e2e.test/items/{id}');
    await api.getByLabel('id', { exact: true }).fill('42');
    await api.getByRole('button', { name: 'Check data' }).click();
    await expect(api.getByRole('status')).toContainText('2 records found');
    expect(requested).toEqual(['https://api.e2e.test/items/42']);

    // Map a field to a path in the record; its live sample shows the real value. `note` is one of
    // the sample label's own fields.
    const note = fieldRow(page, 'note');
    await note.locator('summary').click();
    await note.getByLabel('Rule').selectOption('api');
    await note.getByLabel('Path in the API record').fill('title');
    await expect(note.locator('summary')).toContainText('Alpha');

    // Save, reload. The mapping is still there; the address and its records are not.
    await saveButton(page).click();
    await expect(page.getByText('Saved. This label is on your account.')).toBeVisible();
    await page.reload();
    await designerReady(page);
    await dataTab(page);
    await page.getByRole('button', { name: 'Fields', exact: true }).click();
    await expect(fieldRow(page, 'note').getByLabel('Rule')).toHaveValue('api');

    const panel = await openTestApi(page);
    await expect(panel.getByLabel('Address')).toHaveValue(''); // typed per session, never saved
    await expect(panel.getByRole('status')).toHaveCount(0);
    await expect(panel.getByText(/not saved with the label/)).toBeVisible();

    expect(errors).toEqual([]);
  });

  test('the in-app sample API can be tried without a server', async ({ page }) => {
    // Nothing is routed here: the answer is made inside the app, so this works offline too.
    const errors = watchErrors(page);
    await signUp(page);
    await createLabel(page, { name: 'Api mock', from: 'sample' });
    await dataTab(page);
    await page.getByRole('button', { name: 'Fields', exact: true }).click();

    const api = await openTestApi(page);
    await page.getByRole('button', { name: 'Use the sample API' }).click();
    await expect(api.getByLabel('Address')).toHaveValue(/mock\.q-print\.invalid/);
    await api.getByLabel('count', { exact: true }).fill('3');
    await api.getByRole('button', { name: 'Check data' }).click();
    await expect(api.getByRole('status')).toContainText('3 records found');
    await expect(api.getByTestId('mock-note')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('an api field is offered without any address being typed', async ({ page }) => {
    await signUp(page);
    await createLabel(page, { name: 'Api offered', from: 'sample' });
    await dataTab(page);
    await page.getByRole('button', { name: 'Fields', exact: true }).click();

    // A label may map a field to a record path whether or not anything has been fetched, because
    // the address is given at print time rather than stored with the label.
    const note = fieldRow(page, 'note');
    await note.locator('summary').click();
    await expect(note.getByLabel('Rule')).toContainText('A value from the API response');
  });

  test('shows a server error with advice, and never the token', async ({ page }) => {
    await page.route(API, (route) =>
      route.fulfill({ status: 401, headers: JSON_HEADERS, body: JSON.stringify({ error: 'bad token' }) }),
    );
    await signUp(page);
    await createLabel(page, { name: 'Api error', from: 'sample' });
    await dataTab(page);
    await page.getByRole('button', { name: 'Fields', exact: true }).click();
    const api = await openTestApi(page);

    await api.getByLabel('Address').fill('api.e2e.test/secure');
    await api.getByLabel('Send an access token').check();
    await api.getByRole('textbox', { name: 'Access token' }).fill('wrong-token');
    await api.getByRole('button', { name: 'Check data' }).click();

    const alert = api.getByRole('alert');
    await expect(alert).toContainText('HTTP 401');
    await expect(alert).toContainText('Check the access token.');
    await expect(page.locator('body')).not.toContainText('wrong-token');
    await expect(api.getByLabel('Address')).toHaveValue('api.e2e.test/secure'); // the form survives
  });

  test('the fetched records can be forgotten', async ({ page }) => {
    await page.route(API, (route) =>
      route.fulfill({ status: 200, headers: JSON_HEADERS, body: JSON.stringify(RECORDS) }),
    );
    await signUp(page);
    await createLabel(page, { name: 'Api forget', from: 'sample' });
    await dataTab(page);
    await page.getByRole('button', { name: 'Fields', exact: true }).click();
    const api = await openTestApi(page);
    await api.getByLabel('Address').fill('api.e2e.test/items');
    await api.getByRole('button', { name: 'Check data' }).click();
    await expect(api.getByRole('status')).toContainText('2 records found');

    await page.getByRole('button', { name: 'Forget these records' }).click();
    await expect(page.getByText('Test with a real API')).toBeVisible(); // the panel folds away
    await expect(testApi(page)).toHaveCount(0);

    // Re-opening starts from nothing, as it must: the address belongs to the session.
    await page.getByText('Test with a real API').click();
    await expect((await openTestApi(page)).getByLabel('Address')).toHaveValue('');
  });

  test('a preview with real records says so, and with none says it is using placeholders', async ({ page }) => {
    await page.route(API, (route) =>
      route.fulfill({ status: 200, headers: JSON_HEADERS, body: JSON.stringify(RECORDS) }),
    );
    await signUp(page);
    await createLabel(page, { name: 'Api preview', from: 'sample' });
    await dataTab(page);
    await page.getByRole('button', { name: 'Fields', exact: true }).click();

    // With an api field mapped but nothing fetched, the preview says where the values come from.
    const note = fieldRow(page, 'note');
    await note.locator('summary').click();
    await note.getByLabel('Rule').selectOption('api');
    await note.getByLabel('Path in the API record').fill('title');
    await page.getByRole('button', { name: 'Preview label' }).click();
    let preview = page.getByRole('dialog', { name: 'Label preview' });
    await expect(preview).toContainText('show their path');
    await preview.getByRole('button', { name: 'Close' }).click();

    // With records fetched, it uses them.
    const api = await openTestApi(page);
    await api.getByLabel('Address').fill('api.e2e.test/items');
    await api.getByRole('button', { name: 'Check data' }).click();
    await expect(api.getByRole('status')).toContainText('2 records found');
    await page.getByRole('button', { name: 'Preview label' }).click();
    preview = page.getByRole('dialog', { name: 'Label preview' });
    await expect(preview).toContainText('of the fetched sample');
  });
});
