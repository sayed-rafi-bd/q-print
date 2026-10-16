import { describe, expect, it } from 'vitest';
import { fitName, MAX_NAME, nameProblem } from './labelId';

describe('label names', () => {
  it('allows up to 20 characters and refuses more', () => {
    expect(MAX_NAME).toBe(20);
    expect(nameProblem('a'.repeat(20))).toBeNull();
    expect(nameProblem('a'.repeat(21))).toMatch(/at most 20 characters \(this one has 21\)/);
    expect(nameProblem('   ')).toMatch(/needs a name/);
  });

  it('counts characters, not bytes, so Japanese names get the same room', () => {
    expect(nameProblem('あ'.repeat(20))).toBeNull();
    expect(nameProblem('😀'.repeat(21))).not.toBeNull();
  });

  it('shortens a name so the suffix still fits', () => {
    expect(fitName('Product label', ' copy')).toBe('Product label copy');
    const out = fitName('A very long label name here', ' copy');
    expect(Array.from(out).length).toBeLessThanOrEqual(20);
    expect(out.endsWith(' copy')).toBe(true);
    expect(fitName('x'.repeat(50))).toHaveLength(20);
  });
});
