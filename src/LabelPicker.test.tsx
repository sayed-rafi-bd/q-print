// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LabelPicker, { ReloadLabelsButton, useLabelReload } from './LabelPicker';
import type { LabelMeta } from './labels';

afterEach(cleanup);

const meta = (id: string, name = id): LabelMeta => ({ id, name, builtin: false, widthMm: 100, heightMm: 50 });

const labels = [{ ...meta('product', 'Product label'), builtin: true }, meta('parcel', 'My parcel')];

type HarnessProps = Omit<ComponentProps<typeof LabelPicker>, 'note'> & {
  onReload: () => Promise<string | null>;
};

/** Wires the picker and the reload button together the way the Print tab does. */
function Harness({ onReload, disabled, ...picker }: HarnessProps) {
  const { reload, reloading, note } = useLabelReload(picker.labels, onReload);
  return (
    <>
      <ReloadLabelsButton onClick={reload} reloading={reloading} disabled={disabled} />
      <LabelPicker {...picker} disabled={disabled} note={note} />
    </>
  );
}

const setup = (overrides: Partial<HarnessProps> = {}) => {
  const onChange = vi.fn();
  const onReload = vi.fn(async () => null as string | null);
  render(<Harness labels={labels} value="parcel" onChange={onChange} onReload={onReload} {...overrides} />);
  return { onChange, onReload };
};

const reloadButton = (): HTMLButtonElement =>
  screen.getByRole('button', { name: /reload labels from the database/i }) as HTMLButtonElement;

describe('the label picker', () => {
  it('lists the labels with their page sizes', () => {
    setup();
    const select = screen.getByRole('combobox', { name: 'Label' }) as HTMLSelectElement;
    expect(select.options).toHaveLength(2);
    expect(select.value).toBe('parcel');
    expect(select.options[1].text).toContain('100 × 50 mm');
  });

  it('shows the selected label', () => {
    setup({ value: 'product' });
    expect((screen.getByRole('combobox', { name: 'Label' }) as HTMLSelectElement).value).toBe('product');
  });

  it('tells the caller when a label is chosen', () => {
    const { onChange } = setup();
    fireEvent.change(screen.getByRole('combobox', { name: 'Label' }), { target: { value: 'product' } });
    expect(onChange).toHaveBeenCalledWith('product');
  });

  it('has a reload button that reads the labels again', async () => {
    const { onReload } = setup();
    fireEvent.click(reloadButton());
    await waitFor(() => expect(onReload).toHaveBeenCalledTimes(1));
  });

  it('says so when a reload worked', async () => {
    setup();
    fireEvent.click(reloadButton());
    expect(await screen.findByText('Labels reloaded.')).toBeTruthy();
  });

  it('shows the reason a reload failed, instead of failing silently', async () => {
    setup({ onReload: vi.fn(async () => 'Could not reach the database.') });
    fireEvent.click(reloadButton());
    expect(await screen.findByText('Could not reach the database.')).toBeTruthy();
  });

  it('says so when a reload found nothing', async () => {
    // An empty list is not an error: it is what an account with no labels sees.
    render(<Harness labels={[]} value="" onChange={vi.fn()} onReload={vi.fn(async () => null)} />);
    fireEvent.click(reloadButton());
    expect(await screen.findByText('No labels found.')).toBeTruthy();
  });

  it('clears the previous note when reloading again', async () => {
    // Keep a reference to the mock actually handed to the component: `setup` lets `overrides` win,
    // so the one it creates itself is not the one being called.
    const onReload = vi.fn(async () => 'Could not reach the database.' as string | null);
    setup({ onReload });
    fireEvent.click(reloadButton());
    expect(await screen.findByText('Could not reach the database.')).toBeTruthy();

    // The second attempt works, so the old failure must not linger.
    onReload.mockImplementation(async () => null);
    fireEvent.click(reloadButton());
    // Wait for the end state: waiting for the old message to clear would pass before the second
    // attempt has even finished.
    await waitFor(() => expect(screen.getByText('Labels reloaded.')).toBeTruthy());
    expect(screen.queryByText('Could not reach the database.')).toBeNull();
  });

  it('shows that it is busy while a reload is in flight', async () => {
    let finish!: () => void;
    const slow = vi.fn(
      () =>
        new Promise<string | null>((resolve) => {
          finish = () => resolve(null);
        }),
    );
    setup({ onReload: slow });
    fireEvent.click(reloadButton());
    expect(reloadButton().disabled).toBe(true);
    expect(reloadButton().textContent).toContain('Reloading');
    finish();
    await waitFor(() => expect(reloadButton().disabled).toBe(false));
    expect(screen.getByText('Labels reloaded.')).toBeTruthy();
  });

  it('can reload while a print job is running', async () => {
    // The button is about reading a list, which has nothing to do with printing, so disabling it for
    // the whole job would be arbitrary.
    setup({ busy: true });
    fireEvent.click(reloadButton());
    expect(await screen.findByText('Labels reloaded.')).toBeTruthy();
  });

  it('is disabled entirely when there is no account to read for', () => {
    setup({ disabled: true });
    expect(reloadButton().disabled).toBe(true);
  });

  it('disables the picker when there are no labels', () => {
    render(<Harness labels={[]} value="" onChange={vi.fn()} onReload={vi.fn(async () => null)} />);
    expect((screen.getByRole('combobox', { name: 'Label' }) as HTMLSelectElement).disabled).toBe(true);
  });
});
