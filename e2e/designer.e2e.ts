import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import {
  canvas, createLabel, designerReady, expectCanvasPainted, signIn, signUp, tabButton, uniqueName, watchErrors,
} from './helpers';

/** The text of the red/green status bar under the tabs, or '' when there is none. */
const statusBar = (page: Page) => page.locator('div.border-b.px-4.py-2.text-sm.break-words');

test.describe('web build: signing in', () => {
  test('shows the sign-in page first and the Designer only after signing in', async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Q-Print' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Designer/ })).toHaveCount(0);

    const { username } = await signUp(page);

    await expect(page.getByRole('button', { name: /Designer/ })).toBeVisible();
    await expect(page.getByText(`Signed in as`)).toContainText(username);
    expect(errors).toEqual([]);
  });

  test('has no Print tab: printing needs the desktop app', async ({ page }) => {
    await signUp(page);
    await expect(page.getByRole('button', { name: /Print/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Designer/ })).toBeVisible();
  });

  test('keeps you signed in across a reload and signs out on request', async ({ page }) => {
    const { username, password } = await signUp(page);
    await page.reload();
    await designerReady(page);

    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('heading', { name: 'Q-Print' })).toBeVisible();
    await page.reload();
    await expect(page.getByLabel('Username')).toBeVisible();

    await signIn(page, username, password);
  });

  test('refuses a wrong password without saying which part was wrong', async ({ page }) => {
    const { username } = await signUp(page);
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.getByLabel('Username').fill(username);
    await page.getByLabel('Password').fill('not-the-password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByRole('button', { name: /Designer/ })).toHaveCount(0);
  });
});

test.describe('designer: Layout and Data tabs', () => {
  test('Layout is still there after visiting Data (it used to come back blank)', async ({ page }) => {
    const errors = watchErrors(page);
    await signUp(page);
    await expectCanvasPainted(page);

    for (let round = 1; round <= 3; round++) {
      await tabButton(page, 'Data').click();
      await expect(page.getByRole('heading', { name: 'Data' })).toBeVisible();
      await expect(canvas(page).getByText('Field List')).toBeHidden();

      await tabButton(page, 'Layout').click();
      await expectCanvasPainted(page);
      await expect(page.getByRole('heading', { name: 'Data' })).toHaveCount(0);
    }
    expect(errors).toEqual([]);
  });

  test('the same designer instance survives: fields and unsaved layout edits are kept across tabs', async ({ page }) => {
    await signUp(page);
    await createLabel(page, { name: 'Keeps edits', from: 'sample' });
    await expect(page.getByLabel('Label', { exact: true })).toHaveValue(/keeps-edits/);
    await expectCanvasPainted(page);

    // Resize the page, which is an unsaved layout edit.
    await page.getByLabel('Width in mm').fill('120');
    await page.getByLabel('Height in mm').fill('70');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page.getByText('unsaved changes')).toBeVisible();

    await tabButton(page, 'Data').click();
    await tabButton(page, 'Layout').click();
    await expectCanvasPainted(page);
    await expect(page.getByLabel('Width in mm')).toHaveValue('120');
    await expect(page.getByText('unsaved changes')).toBeVisible();
  });

  test('Data editor can be opened for a label of your own and for a built-in one', async ({ page }) => {
    await signUp(page);
    await tabButton(page, 'Data').click();
    await expect(page.getByRole('heading', { name: 'Data' })).toBeVisible();   // built-in (read-only)
    await tabButton(page, 'Layout').click();
    await createLabel(page, { name: 'Mine', from: 'sample' });
    await expect(page.getByLabel('Label', { exact: true })).toHaveValue(/mine/);
    await tabButton(page, 'Data').click();
    await expect(page.getByRole('heading', { name: 'Data' })).toBeVisible();
    await tabButton(page, 'Layout').click();
    await expectCanvasPainted(page);
  });
});

test.describe('designer: creating labels', () => {
  test('a new blank label opens without the pdfme basePdf error', async ({ page }) => {
    const errors = watchErrors(page);
    await signUp(page);

    await createLabel(page, { name: 'Blank one', from: 'blank', size: [100, 50] });

    await expect(page.getByLabel('Label', { exact: true })).toHaveValue(/blank-one/);
    await expect(statusBar(page)).toHaveCount(0);
    await expect(page.getByText(/basePdf|Invalid argument|Invalid input/)).toHaveCount(0);
    await expectCanvasPainted(page);
    await expect(page.getByLabel('Width in mm')).toHaveValue('100');
    await expect(page.getByLabel('Height in mm')).toHaveValue('50');
    expect(errors).toEqual([]);
  });

  for (const [title, from] of [
    ['the sample label', 'sample'],
    ['a copy of a built-in label', /Copy of/],
  ] as const) {
    test(`a new label from ${title} opens cleanly`, async ({ page }) => {
      const errors = watchErrors(page);
      await signUp(page);
      await createLabel(page, { name: `From ${title}`, from, size: [90, 60] });
      await expect(page.getByLabel('Label', { exact: true })).toHaveValue(/from-/);
      await expect(page.getByText(/basePdf|Invalid argument|Invalid input/)).toHaveCount(0);
      await expectCanvasPainted(page);
      await expect(page.getByLabel('Width in mm')).toHaveValue('90');
      expect(errors).toEqual([]);
    });
  }

  test('a new label can be saved, survives sign-out and a reload, and opens again', async ({ page }) => {
    const { username, password } = await signUp(page);
    await createLabel(page, { name: 'Survivor', from: 'blank', size: [80, 40] });
    await expectCanvasPainted(page);

    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(statusBar(page)).toContainText('Saved. This label is on your account.');
    await expect(page.getByText('unsaved changes')).toHaveCount(0);

    await page.getByRole('button', { name: 'Sign out' }).click();
    await signIn(page, username, password);
    await expect(page.getByLabel('Label', { exact: true })).toHaveValue(/survivor/);   // remembered
    await expectCanvasPainted(page);
    await expect(page.getByLabel('Width in mm')).toHaveValue('80');

    await page.reload();
    await designerReady(page);
    await expect(page.getByLabel('Label', { exact: true })).toHaveValue(/survivor/);
  });

  test('another account does not see your labels', async ({ page }) => {
    await signUp(page);
    await createLabel(page, { name: 'Private', from: 'blank', size: [60, 30] });
    await expectCanvasPainted(page);
    await page.getByRole('button', { name: 'Sign out' }).click();

    await signUp(page);
    await expect(page.getByLabel('Label', { exact: true }).locator('option', { hasText: 'Private' })).toHaveCount(0);
  });

  test('duplicate, rename and delete work on a label of your own', async ({ page }) => {
    await signUp(page);
    await createLabel(page, { name: 'Original', from: 'sample' });
    await expectCanvasPainted(page);

    await page.getByRole('button', { name: 'Duplicate' }).click();
    await expect(page.getByLabel('Label', { exact: true })).toHaveValue(/original-copy/);
    await expectCanvasPainted(page);

    await page.getByRole('button', { name: 'Rename' }).click();
    await page.getByLabel('Rename', { exact: true }).fill('Renamed');
    await page.getByRole('button', { name: 'Save', exact: true }).first().click();
    await expect(page.getByLabel('Label', { exact: true }).locator('option', { hasText: 'Renamed' })).toHaveCount(1);

    await page.getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('button', { name: 'Yes, delete' }).click();
    await expect(page.getByLabel('Label', { exact: true }).locator('option', { hasText: 'Renamed' })).toHaveCount(0);
    await expectCanvasPainted(page);
  });
});

test.describe('designer: unsaved-changes tracking', () => {
  test('an untouched label is not reported as changed (and does not pulse)', async ({ page }) => {
    await signUp(page);
    await page.waitForTimeout(1500);   // pdfme reports its own start-up changes late
    await expect(page.getByText('unsaved changes')).toHaveCount(0);
    await expect(page.getByText('data not saved')).toHaveCount(0);
    await expect(tabButton(page, 'Data')).not.toContainText('•');
  });

  test('switching labels does not ask to discard when nothing was changed', async ({ page }) => {
    await signUp(page);
    await createLabel(page, { name: 'Second', from: 'sample' });
    await expectCanvasPainted(page);
    await page.waitForTimeout(1000);
    await page.getByLabel('Label', { exact: true }).selectOption({ index: 0 });
    await expect(page.getByText(/Discard unsaved changes/)).toHaveCount(0);
    await expectCanvasPainted(page);
  });

  test('an edit is flagged, and saving clears the flag', async ({ page }) => {
    await signUp(page);
    await createLabel(page, { name: 'Edited', from: 'sample' });
    await expectCanvasPainted(page);
    await page.getByLabel('Width in mm').fill('77');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page.getByText('unsaved changes')).toBeVisible();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('unsaved changes')).toHaveCount(0);
  });
});

test.describe('designer: animation', () => {
  /** After the entrance animation, nothing may be left transformed, faded or hidden. */
  const settled = async (page: Page) =>
    canvas(page).evaluate(el => {
      const chain: { tag: string; transform: string; opacity: string; visibility: string }[] = [];
      for (let n: Element | null = el; n && n !== document.documentElement; n = n.parentElement) {
        const cs = getComputedStyle(n);
        chain.push({ tag: n.tagName + (n.className ? '.' + String(n.className).split(' ')[0] : ''), transform: cs.transform, opacity: cs.opacity, visibility: cs.visibility });
      }
      return chain;
    });

  test('no ancestor of the canvas keeps a transform, fade or hidden state once settled', async ({ page }) => {
    await signUp(page);
    await expectCanvasPainted(page);
    await page.waitForTimeout(800);   // longer than any entrance animation
    const bad = (await settled(page)).filter(c => c.transform !== 'none' || c.opacity !== '1' || c.visibility !== 'visible');
    expect(bad).toEqual([]);

    // ...and again after bouncing between the tabs and after creating a label.
    await tabButton(page, 'Data').click();
    await tabButton(page, 'Layout').click();
    await createLabel(page, { name: 'Anim', from: 'blank', size: [100, 50] });
    await expectCanvasPainted(page);
    await page.waitForTimeout(800);
    const bad2 = (await settled(page)).filter(c => c.transform !== 'none' || c.opacity !== '1' || c.visibility !== 'visible');
    expect(bad2).toEqual([]);
  });

  test('the canvas does not jump about while the New dialog opens and closes', async ({ page }) => {
    await signUp(page);
    await expectCanvasPainted(page);
    // Rapidly toggling must always end with a usable, same-sized designer.
    const before = await canvas(page).boundingBox();
    for (let i = 0; i < 4; i++) {
      await page.getByRole('button', { name: 'New', exact: true }).click();
      await page.getByRole('button', { name: 'Close', exact: true }).click();
    }
    await page.waitForTimeout(600);
    await expectCanvasPainted(page);
    const after = await canvas(page).boundingBox();
    expect(Math.abs((after?.height ?? 0) - (before?.height ?? 0))).toBeLessThan(2);
  });

  test('the loading animation goes away once the designer is ready', async ({ page }) => {
    await signUp(page);
    await expect(page.getByText('Loading designer…')).toHaveCount(0);
  });

  test('rapid tab switching ends in a consistent state', async ({ page }) => {
    const errors = watchErrors(page);
    await signUp(page);
    for (let i = 0; i < 12; i++) {
      await tabButton(page, i % 2 ? 'Layout' : 'Data').click();
    }
    await tabButton(page, 'Layout').click();
    await expectCanvasPainted(page);
    await expect(page.getByRole('heading', { name: 'Data' })).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});

/** Rewrites a label's stored template directly in the (fake) database, as an older build would have. */
async function rewriteTemplate(request: APIRequestContext, name: string, edit: (t: Record<string, unknown>) => Record<string, unknown>) {
  const pipeline = (stmt: object) => request.post('http://localhost:8787/v2/pipeline', {
    data: { requests: [{ type: 'execute', stmt }, { type: 'close' }] },
  }).then(r => r.json());
  const got = await pipeline({ sql: 'SELECT template FROM labels WHERE name = ?', args: [{ type: 'text', value: name }] });
  const stored = got.results[0].response.result.rows[0][0].value as string;
  const next = JSON.stringify(edit(JSON.parse(stored)));
  const done = await pipeline({
    sql: 'UPDATE labels SET template = ? WHERE name = ?',
    args: [{ type: 'text', value: next }, { type: 'text', value: name }],
  });
  expect(done.results[0].type).toBe('ok');
}

test.describe('designer: labels saved by the older version', () => {
  test('a label that is missing basePdf.padding is repaired and opens', async ({ page, request }) => {
    const errors = watchErrors(page);
    const name = uniqueName('Legacy');
    await signUp(page);
    await createLabel(page, { name, from: 'blank', size: [100, 50] });
    await expectCanvasPainted(page);

    // What the earlier "New label" wrote: a blank page with no padding. It is also the last label used.
    await rewriteTemplate(request, name, t => ({ ...t, basePdf: { width: 100, height: 50 } }));
    await page.reload();

    await designerReady(page);
    await expect(page.getByLabel('Label', { exact: true }).locator('option:checked')).toContainText(name);
    await expect(page.getByText(/basePdf|Invalid argument|Invalid input|Could not open/)).toHaveCount(0);
    await expectCanvasPainted(page);
    expect(errors.filter(e => !e.includes('Failed to load resource'))).toEqual([]);
  });

  test('a label that cannot be opened at all does not lock you out: it falls back and can be deleted', async ({ page, request }) => {
    const name = uniqueName('Broken');
    await signUp(page);
    await createLabel(page, { name, from: 'blank', size: [100, 50] });
    await expectCanvasPainted(page);

    await rewriteTemplate(request, name, t => ({ ...t, basePdf: 'not-a-pdf-at-all' }));
    await page.reload();

    // The designer still comes up, on a built-in label, and says what went wrong.
    await designerReady(page);
    await expect(statusBar(page)).toContainText('Could not open');
    await expectCanvasPainted(page);
    await expect(page.getByLabel('Label', { exact: true }).locator('option', { hasText: name })).toHaveCount(1);

    // The broken label can be picked and removed.
    await page.getByLabel('Label', { exact: true }).selectOption({ label: `${name} (your label)` });
    await page.getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('button', { name: 'Yes, delete' }).click();
    await expect(page.getByLabel('Label', { exact: true }).locator('option', { hasText: name })).toHaveCount(0);
    await expectCanvasPainted(page);
  });
});
