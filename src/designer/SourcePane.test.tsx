// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as client from '../apiClient';
import { validateSpec } from '../generator/engine';
import type { ApiSource, GeneratorSpec } from '../generator/spec';
import DataEditor from './DataEditor';
import { RuleRow } from './RuleEditor';
import SourcePane from './SourcePane';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Pane({ initial, usedByFields = true }: { initial?: ApiSource; usedByFields?: boolean }) {
  const [source, setSource] = useState<ApiSource | undefined>(initial);
  const [sample, setSample] = useState<unknown[] | null>(null);
  return (
    <>
      <SourcePane
        source={source}
        onChange={setSource}
        sample={sample}
        onSample={setSample}
        usedByFields={usedByFields}
      />
      <div data-testid="saved">{JSON.stringify(source ?? null)}</div>
    </>
  );
}
const saved = (): ApiSource | null => JSON.parse(screen.getByTestId('saved').textContent ?? 'null');

describe('the Source pane', () => {
  it('starts with a button that turns the data source on', () => {
    render(<Pane />);
    fireEvent.click(screen.getByRole('button', { name: /use an api/i }));
    expect(saved()).toEqual({ url: '' });
  });

  it('detects variables from the URL and reports URL problems', () => {
    render(<Pane initial={{ url: '' }} />);
    fireEvent.change(screen.getByLabelText('URL pattern'), { target: { value: 'ftp://x.com/{day}' } });
    expect(screen.getByText(/Only http and https/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('URL pattern'), { target: { value: 'api.example.com/{day}/{count}' } });
    // each variable shows as a chip and again as a row of its own settings
    expect(screen.getAllByText('day').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('count').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByLabelText('Label for day')).toBeTruthy();
    expect(screen.getByLabelText('Label for count')).toBeTruthy();
  });

  it('keeps only what is set: no empty list path, no false bearer flag, no stale variables', () => {
    render(<Pane initial={{ url: 'a.com/{x}', variables: { x: { label: 'X' } } }} />);
    fireEvent.change(screen.getByLabelText('List path (optional)'), { target: { value: 'data' } });
    fireEvent.change(screen.getByLabelText('List path (optional)'), { target: { value: '' } });
    expect(saved()).toEqual({ url: 'a.com/{x}', variables: { x: { label: 'X' } } });
    fireEvent.change(screen.getByLabelText('URL pattern'), { target: { value: 'a.com/{y}' } });
    expect(saved()).toEqual({ url: 'a.com/{y}' });
  });

  it('stores variable labels and defaults, and the bearer toggle, but never a token', () => {
    render(<Pane initial={{ url: 'a.com/{day}' }} />);
    fireEvent.change(screen.getByLabelText('Label for day'), { target: { value: 'Delivery day' } });
    fireEvent.change(screen.getByLabelText('Default for day'), { target: { value: 'today' } });
    fireEvent.click(screen.getByLabelText('Use a bearer token'));
    fireEvent.change(screen.getByLabelText('Access token'), { target: { value: 'sekret' } });
    expect(saved()).toEqual({
      url: 'a.com/{day}',
      bearerAuth: true,
      variables: { day: { label: 'Delivery day', default: 'today' } },
    });
    expect(screen.getByTestId('saved').textContent).not.toContain('sekret');
  });

  it('fetches a sample, shows the paths, and clears the token afterwards', async () => {
    const spy = vi.spyOn(client, 'fetchRecords').mockResolvedValue([{ user: { name: 'Ann' }, n: 1 }]);
    render(<Pane initial={{ url: 'a.com/{day}', bearerAuth: true, variables: { day: { default: 'mon' } } }} />);
    fireEvent.change(screen.getByLabelText('Access token'), { target: { value: 'tok' } });
    fireEvent.click(screen.getByRole('button', { name: 'Fetch sample' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('1 record found'));
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ url: 'a.com/{day}' }), { day: 'mon' }, 'tok');
    expect(screen.getByText('user.name')).toBeTruthy();
    expect((screen.getByLabelText('Access token') as HTMLInputElement).value).toBe('');
    expect(screen.getByTestId('saved').textContent).not.toContain('tok"');
  });

  it('shows a fetch error without the token', async () => {
    vi.spyOn(client, 'fetchRecords').mockRejectedValue(new Error('HTTP 401 Unauthorized'));
    render(<Pane initial={{ url: 'a.com/x', bearerAuth: true }} />);
    fireEvent.change(screen.getByLabelText('Access token'), { target: { value: 'sekret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Fetch sample' }));
    expect((await screen.findByRole('alert')).textContent).toContain('401');
    expect(document.body.textContent).not.toContain('sekret');
  });

  it('drops the sample when the address changes', async () => {
    vi.spyOn(client, 'fetchRecords').mockResolvedValue([{ a: 1 }]);
    render(<Pane initial={{ url: 'a.com/x' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Fetch sample' }));
    await screen.findByRole('status');
    fireEvent.change(screen.getByLabelText('URL pattern'), { target: { value: 'a.com/y' } });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('can stop using an API', () => {
    render(<Pane initial={{ url: 'a.com/x' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop using an API' }));
    expect(saved()).toBeNull();
  });
});

describe('the api rule in the rule picker', () => {
  const ruleOptions = () => screen.getAllByRole('option').map((o) => (o as HTMLOptionElement).value);
  const noop = () => {};

  it('is hidden until the label has a data source', () => {
    render(<RuleRow rule={null} spec={{ version: 1, fields: {} }} fieldNames={[]} onChange={noop} />);
    expect(ruleOptions()).not.toContain('api');
  });

  it('is offered once the label has a data source', () => {
    const spec: GeneratorSpec = { version: 1, source: { url: 'a.com/x' }, fields: {} };
    render(<RuleRow rule={null} spec={spec} fieldNames={[]} onChange={noop} />);
    expect(ruleOptions()).toContain('api');
  });

  it('suggests the sample paths for the path input', () => {
    const spec: GeneratorSpec = { version: 1, source: { url: 'a.com/x' }, fields: {} };
    const { container } = render(
      <RuleRow
        rule={{ kind: 'api', path: '' }}
        spec={spec}
        fieldNames={[]}
        samplePaths={['user.name', 'items[0].id']}
        onChange={noop}
      />,
    );
    const values = [...container.querySelectorAll('datalist option')].map((o) => o.getAttribute('value'));
    expect(values).toEqual(['user.name', 'items[0].id']);
  });
});

describe('the Data tab with an API source', () => {
  const template = {
    basePdf: { width: 100, height: 50, padding: [0, 0, 0, 0] },
    schemas: [[{ name: 'who', type: 'text', position: { x: 0, y: 0 }, width: 10, height: 5 }]],
  } as never;

  function Editor({
    spec,
    sample,
    onOpenSource,
  }: {
    spec: GeneratorSpec;
    sample: unknown[] | null;
    onOpenSource?: () => void;
  }) {
    const [s, setS] = useState(spec);
    return (
      <DataEditor
        template={template}
        spec={s}
        onChange={setS}
        onPreview={() => {}}
        sample={sample}
        onOpenSource={onOpenSource}
      />
    );
  }

  it('shows the real value from the sample next to an api field', () => {
    const spec: GeneratorSpec = {
      version: 1,
      source: { url: 'a.com/x' },
      fields: { who: { kind: 'api', path: 'user.name' } },
    };
    render(<Editor spec={spec} sample={[{ user: { name: 'Ann' } }]} />);
    expect(screen.getByText('Ann')).toBeTruthy();
  });

  it('shows the path in ‹ › when no sample was fetched', () => {
    const spec: GeneratorSpec = {
      version: 1,
      source: { url: 'a.com/x' },
      fields: { who: { kind: 'api', path: 'user.name' } },
    };
    render(<Editor spec={spec} sample={null} />);
    expect(screen.getByText('‹user.name›')).toBeTruthy();
  });

  it('warns when a path is not in the sample', () => {
    const spec: GeneratorSpec = {
      version: 1,
      source: { url: 'a.com/x' },
      fields: { who: { kind: 'api', path: 'nope' } },
    };
    render(<Editor spec={spec} sample={[{ user: 1 }]} />);
    fireEvent.click(screen.getByText('who'));
    expect(screen.getByText(/was not found/)).toBeTruthy();
  });

  it('points to the top-level Source tab instead of holding the source itself', () => {
    const open = vi.fn();
    render(<Editor spec={{ version: 1, fields: {} }} sample={null} onOpenSource={open} />);
    expect(screen.queryByRole('button', { name: 'Source' })).toBeNull(); // no Source pill inside Data
    fireEvent.click(screen.getByRole('button', { name: 'Source tab' }));
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('keeps a label valid once the source and an api field are filled in', () => {
    const spec: GeneratorSpec = {
      version: 1,
      source: { url: 'a.com/{d}' },
      fields: { who: { kind: 'api', path: 'name' } },
    };
    expect(validateSpec(spec)).toEqual([]);
  });
});
