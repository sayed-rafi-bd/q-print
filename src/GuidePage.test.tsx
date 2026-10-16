// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

let platform = 'windows';
vi.mock('./capabilities', () => ({ useCapabilities: () => ({ platform }) }));

import GuidePage from './GuidePage';

afterEach(cleanup);

describe('the guide', () => {
  it('explains printing and the API address on the desktop app', () => {
    platform = 'windows';
    render(<GuidePage />);
    expect(screen.getByRole('heading', { name: 'Printing a label' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Reading data from an API' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Designing a label' })).toBeTruthy();
  });

  it('leaves out printing steps on the web, where nothing can print', () => {
    platform = 'web';
    render(<GuidePage />);
    expect(screen.queryByRole('heading', { name: 'Printing a label' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Reading data from an API' })).toBeTruthy();
  });

  it('every contents link points at a section that exists', () => {
    for (platform of ['windows', 'web']) {
      const { container, unmount } = render(<GuidePage />);
      const links = container.querySelectorAll('nav a');
      expect(links.length).toBeGreaterThan(0);
      for (const a of links) {
        expect(container.querySelector(a.getAttribute('href') as string)).not.toBeNull();
      }
      unmount();
    }
  });
});
