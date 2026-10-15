// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Modal from './Modal';

afterEach(cleanup);

const openModal = (props: Partial<React.ComponentProps<typeof Modal>> = {}) => {
  const onClose = vi.fn();
  render(
    <Modal open title="Delete label" onClose={onClose} footer={<button type="button">Yes, delete</button>} {...props}>
      <p>“Parcel” will be removed.</p>
    </Modal>,
  );
  return { onClose };
};

const backdrop = () => screen.getByRole('dialog').parentElement as HTMLElement;

describe('the modal', () => {
  it('renders nothing when closed', () => {
    render(
      <Modal open={false} title="Delete" onClose={vi.fn()}>
        Body
      </Modal>,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows its title and body', () => {
    openModal();
    expect(screen.getByRole('dialog', { name: 'Delete label' })).toBeTruthy();
    expect(screen.getByText('“Parcel” will be removed.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Yes, delete' })).toBeTruthy();
  });

  it('is marked as a dialog the rest of the page is blocked behind', () => {
    openModal();
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('tabindex')).toBe('-1');
  });

  it('takes focus when it opens, so the keyboard reaches it first', () => {
    openModal();
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
  });

  it('closes on Escape', () => {
    const { onClose } = openModal();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not close on any other key', () => {
    const { onClose } = openModal();
    for (const key of ['Enter', 'a', 'Escapee', 'Tab']) {
      fireEvent.keyDown(document, { key });
    }
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on a click outside the dialog, but not on one inside it', () => {
    const { onClose } = openModal();
    // The dialog's own parent is the backdrop wrapper: a click there is outside the dialog.
    fireEvent.mouseDown(backdrop());
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.mouseDown(screen.getByRole('dialog'));
    expect(onClose).toHaveBeenCalledTimes(1); // unchanged
  });

  it('does not close when the backdrop is clicked while a mouse-down started inside', () => {
    const { onClose } = openModal();
    fireEvent.mouseDown(screen.getByRole('dialog'));
    fireEvent.mouseUp(backdrop());
    fireEvent.click(backdrop());
    expect(onClose).not.toHaveBeenCalled();
  });

  it('leaves the actions to the caller', () => {
    const { onClose } = openModal();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, delete' }));
    // The modal does not decide what a button does; it only asks to be closed via escape/backdrop.
    expect(onClose).not.toHaveBeenCalled();
  });
});
