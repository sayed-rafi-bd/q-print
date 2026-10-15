// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as client from './apiClient';
import DataSourceCard, { type CheckState, resolvedAddress } from './DataSourceCard';
import type { ApiSource } from './generator/spec';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const source: ApiSource = { url: 'api.example.com/day/{day}/count/{count}/logs', bearerAuth: true };

function Harness({ src = source, copies = 3 }: { src?: ApiSource; copies?: number }) {
  const [values, setValues] = useState<Record<string, string>>({ day: '', count: '' });
  const [token, setToken] = useState('');
  const [checked, setChecked] = useState<CheckState>(null);
  return (
    <DataSourceCard
      source={src}
      values={values}
      onValues={setValues}
      token={token}
      onToken={setToken}
      copies={copies}
      checked={checked}
      onChecked={setChecked}
    />
  );
}

describe('the data source card', () => {
  it('asks for one input per variable and shows the host in bold', () => {
    render(<Harness />);
    expect(screen.getByLabelText('day')).toBeTruthy();
    expect(screen.getByLabelText('count')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('day'), { target: { value: '2026/10/15' } });
    fireEvent.change(screen.getByLabelText('count'), { target: { value: '5' } });
    const url = screen.getByTestId('resolved-url');
    expect(url.querySelector('strong')?.textContent).toBe('api.example.com');
    expect(url.textContent).toContain('/day/2026%2F10%2F15/count/5/logs');
  });

  it('masks the token and does not autofill it', () => {
    render(<Harness />);
    const t = screen.getByLabelText('Access token') as HTMLInputElement;
    expect(t.type).toBe('password');
    expect(t.getAttribute('autocomplete')).toBe('off');
  });

  it('has no token input when the label does not use bearer auth', () => {
    render(<Harness src={{ url: 'api.example.com/x/{a}' }} />);
    expect(screen.queryByLabelText('Access token')).toBeNull();
  });

  it('uses the variable label from the source', () => {
    render(<Harness src={{ url: 'a.com/{d}', variables: { d: { label: 'Delivery day' } } }} />);
    expect(screen.getByLabelText('Delivery day')).toBeTruthy();
  });

  it('checks the data and reports records x copies = pages', async () => {
    const spy = vi.spyOn(client, 'fetchRecords').mockResolvedValue([{ a: 1 }, { a: 2 }, { a: 3 }]);
    render(<Harness />);
    fireEvent.change(screen.getByLabelText('day'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('count'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Access token'), { target: { value: 'tok' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check data' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('3 records found'));
    expect(screen.getByRole('status').textContent).toContain('3 × 3 = 9 pages');
    expect(spy).toHaveBeenCalledWith(source, { day: '1', count: '2' }, 'tok');
    expect(screen.getByText('First record')).toBeTruthy();
  });

  it('shows a fetch error and never the token', async () => {
    vi.spyOn(client, 'fetchRecords').mockRejectedValue(new Error('HTTP 401 Unauthorized'));
    render(<Harness />);
    fireEvent.change(screen.getByLabelText('Access token'), { target: { value: 'sekret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check data' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('401');
    expect(document.body.textContent).not.toContain('sekret');
  });

  it('forgets an earlier check when a value changes', async () => {
    vi.spyOn(client, 'fetchRecords').mockResolvedValue([{ a: 1 }]);
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Check data' }));
    await screen.findByRole('status');
    fireEvent.change(screen.getByLabelText('day'), { target: { value: '9' } });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('ignores an answer that arrives after the values changed', async () => {
    let resolve: (v: unknown[]) => void = () => {};
    vi.spyOn(client, 'fetchRecords').mockReturnValue(new Promise((r) => (resolve = r)));
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Check data' }));
    fireEvent.change(screen.getByLabelText('day'), { target: { value: '9' } });
    resolve([{ a: 1 }]);
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('resolvedAddress', () => {
  it('fills in what it can while values are missing', () => {
    const a = resolvedAddress(source, { day: 'x' });
    expect(a.ready).toBe(false);
    expect(a.host).toBe('api.example.com');
    expect(a.rest).toContain('/day/x/count/{count}');
  });
});
