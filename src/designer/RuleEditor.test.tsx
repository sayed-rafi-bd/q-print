// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RULE_KINDS } from '../generator/spec';
import { RULE_GROUPS, RuleRow } from './RuleEditor';

afterEach(cleanup);

const spec = { version: 1 as const, fields: {} };
const picker = () => screen.getByLabelText('Rule') as HTMLSelectElement;
const groups = () => [...picker().querySelectorAll('optgroup')];

describe('the "Fill this field with" picker', () => {
  it('puts every kind in exactly one group', () => {
    const listed = RULE_GROUPS.flatMap((g) => g.kinds);
    expect([...listed].sort()).toEqual([...RULE_KINDS].sort());
  });

  it('offers real data first, then the other groups', () => {
    render(<RuleRow rule={null} spec={spec} fieldNames={[]} onChange={() => {}} />);
    expect(groups().map((g) => g.label)).toEqual([
      'Real data',
      'Random data',
      'Fixed or numbered',
      'From another field',
    ]);
    // The first real choice, straight after "nothing", is the API value.
    expect(picker().options[0].value).toBe('');
    expect(picker().options[1].value).toBe('api');
    expect(picker().options[1].textContent).toBe('A value from the API response');
  });

  it('selecting a kind still hands back that kind’s rule', () => {
    const onChange = vi.fn();
    render(<RuleRow rule={null} spec={spec} fieldNames={[]} onChange={onChange} />);
    fireEvent.change(picker(), { target: { value: 'api' } });
    expect(onChange).toHaveBeenCalledWith({ kind: 'api', path: '' });
    fireEvent.change(picker(), { target: { value: 'digits' } });
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'digits', length: 12 });
  });

  it('drops the Real data group when the API kind is switched off', () => {
    render(<RuleRow rule={null} spec={spec} fieldNames={[]} hasApi={false} onChange={() => {}} />);
    expect(groups().map((g) => g.label)).not.toContain('Real data');
  });
});
