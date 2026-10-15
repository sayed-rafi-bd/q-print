// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as client from './apiClient';
import DataSourceCard, { type ApiState, type CheckState, emptyApi, resolvedAddress } from './DataSourceCard';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const URL_WITH_VARS = 'api.example.com/day/{day}/count/{count}/logs';

function Harness({ copies = 3, remembered = {} }: { copies?: number; remembered?: Record<string, string> }) {
  const [api, setApi] = useState<ApiState>(emptyApi);
  const [checked, setChecked] = useState<CheckState>(null);
  return (
    <DataSourceCard
      api={api}
      onChange={setApi}
      remembered={remembered}
      copies={copies}
      checked={checked}
      onChecked={setChecked}
    />
  );
}

/** Types the address, which is what brings the variables into being. */
const typeUrl = (text: string) => fireEvent.change(screen.getByLabelText('Address'), { target: { value: text } });

describe('the data source card', () => {
  it('starts empty: nothing is carried over from a label', () => {
    render(<Harness />);
    expect((screen.getByLabelText('Address') as HTMLInputElement).value).toBe('');
    expect(screen.queryByLabelText('day')).toBeNull();
  });

  it('asks for one input per variable the address declares', () => {
    render(<Harness />);
    typeUrl(URL_WITH_VARS);
    expect(screen.getByLabelText('day')).toBeTruthy();
    expect(screen.getByLabelText('count')).toBeTruthy();
  });

  it('offers remembered values for those variables, once the address names them', () => {
    // The address itself is never remembered, so this is the first moment they can be offered.
    render(<Harness remembered={{ day: '2026/10/15', unused: 'x' }} />);
    typeUrl(URL_WITH_VARS);
    expect((screen.getByLabelText('day') as HTMLInputElement).value).toBe('2026/10/15');
    expect((screen.getByLabelText('count') as HTMLInputElement).value).toBe('');
  });

  it('shows the host in bold and the address that will be called', () => {
    render(<Harness />);
    typeUrl(URL_WITH_VARS);
    fireEvent.change(screen.getByLabelText('day'), { target: { value: '2026/10/15' } });
    fireEvent.change(screen.getByLabelText('count'), { target: { value: '5' } });
    const url = screen.getByTestId('resolved-url');
    expect(url.querySelector('strong')?.textContent).toBe('https://api.example.com/day/2026%2F10%2F15/count/5/logs');
  });

  it('has no token input until the person asks to send one', () => {
    render(<Harness />);
    expect(screen.queryByLabelText('Access token')).toBeNull();
    fireEvent.click(screen.getByLabelText('Send an access token'));
    expect(screen.getByLabelText('Access token')).toBeTruthy();
  });

  it('masks the token and does not autofill it', () => {
    render(<Harness />);
    fireEvent.click(screen.getByLabelText('Send an access token'));
    const t = screen.getByLabelText('Access token') as HTMLInputElement;
    expect(t.type).toBe('password');
    expect(t.getAttribute('autocomplete')).toBe('off');
  });

  it('checks the data and reports records x copies = pages', async () => {
    const spy = vi.spyOn(client, 'fetchRecords').mockResolvedValue([{ a: 1 }, { a: 2 }, { a: 3 }]);
    render(<Harness />);
    typeUrl(URL_WITH_VARS);
    fireEvent.change(screen.getByLabelText('day'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('count'), { target: { value: '2' } });
    fireEvent.click(screen.getByLabelText('Send an access token'));
    fireEvent.change(screen.getByLabelText('Access token'), { target: { value: 'tok' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check data' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('3 records found'));
    expect(screen.getByRole('status').textContent).toContain('3 × 3 = 9 pages');
    expect(spy).toHaveBeenCalledWith(
      { url: URL_WITH_VARS, listPath: undefined, bearerAuth: true },
      { day: '1', count: '2' },
      'tok',
    );
    expect(screen.getByText('First record')).toBeTruthy();
  });

  it('passes the list path when one is typed', async () => {
    const spy = vi.spyOn(client, 'fetchRecords').mockResolvedValue([{ a: 1 }]);
    render(<Harness />);
    typeUrl('a.com/x');
    fireEvent.change(screen.getByLabelText('Where the list is in the response'), { target: { value: 'data.items' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check data' }));
    await screen.findByRole('status');
    expect(spy).toHaveBeenCalledWith({ url: 'a.com/x', listPath: 'data.items', bearerAuth: false }, {}, '');
  });

  it('hands the records to whoever asked for them, so the Designer can preview with them', async () => {
    vi.spyOn(client, 'fetchRecords').mockResolvedValue([{ a: 1 }, { a: 2 }]);
    const got: unknown[] = [];
    const Test = () => {
      const [api, setApi] = useState<ApiState>(emptyApi);
      return (
        <DataSourceCard
          api={api}
          onChange={setApi}
          remembered={{}}
          copies={1}
          checked={null}
          onChecked={() => {}}
          onRecords={(r) => got.push(...r)}
        />
      );
    };
    render(<Test />);
    typeUrl('a.com/x');
    fireEvent.click(screen.getByRole('button', { name: 'Check data' }));
    await waitFor(() => expect(got).toHaveLength(2));
    expect(got).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('shows a fetch error and never the token', async () => {
    vi.spyOn(client, 'fetchRecords').mockRejectedValue(new Error('HTTP 401 Unauthorized'));
    render(<Harness />);
    fireEvent.click(screen.getByLabelText('Send an access token'));
    fireEvent.change(screen.getByLabelText('Access token'), { target: { value: 'sekret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check data' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('401');
    expect(document.body.textContent).not.toContain('sekret');
  });

  it('forgets an earlier check when anything changes', async () => {
    vi.spyOn(client, 'fetchRecords').mockResolvedValue([{ a: 1 }]);
    render(<Harness />);
    typeUrl(URL_WITH_VARS);
    fireEvent.click(screen.getByRole('button', { name: 'Check data' }));
    await screen.findByRole('status');
    fireEvent.change(screen.getByLabelText('day'), { target: { value: '9' } });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('ignores an answer that arrives after the values changed', async () => {
    let resolve: (v: unknown[]) => void = () => {};
    vi.spyOn(client, 'fetchRecords').mockReturnValue(new Promise((r) => (resolve = r)));
    render(<Harness />);
    typeUrl(URL_WITH_VARS);
    fireEvent.click(screen.getByRole('button', { name: 'Check data' }));
    fireEvent.change(screen.getByLabelText('day'), { target: { value: '9' } });
    resolve([{ a: 1 }]);
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('resolvedAddress', () => {
  it('fills in what it can while values are missing', () => {
    const a = resolvedAddress(URL_WITH_VARS, { day: 'x' });
    expect(a.host).toBe('api.example.com');
    expect(a.rest).toContain('/day/x/count/{count}');
  });
});
