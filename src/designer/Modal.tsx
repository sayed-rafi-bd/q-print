import { type ReactNode, useEffect, useRef } from 'react';

type Props = {
  open: boolean;
  title: string;
  onClose: () => void;
  children?: ReactNode;
  footer?: ReactNode;
};

/**
 * A modal dialog.
 *
 * Used for confirmations, so that asking before something destructive is a separate thing from the
 * thing itself rather than a row of buttons appearing where the toolbar was.
 *
 * Closes on Escape and on a click outside, and takes focus when it opens so the keyboard goes to the
 * dialog rather than whatever was behind it.
 *
 * Never taller than the screen: the title and the buttons stay where they are and the body scrolls,
 * so on a short phone in landscape the actions are still reachable.
 */
export default function Modal({ open, title, onClose, children, footer }: Props) {
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    dialog.current?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    // Capturing, so the dialog sees Escape before the page's own handlers.
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open, onClose]);

  if (!open) return null;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click is a mouse convenience; Escape (document listener above) is the keyboard path
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* the backdrop: separate so clicking it closes, but the text on it does not */}
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" aria-hidden="true" />
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="tab-enter relative flex max-h-full w-full max-w-md flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl outline-none"
      >
        <h2 className="shrink-0 text-lg font-semibold text-slate-900">{title}</h2>
        <div className="min-h-0 overflow-y-auto text-sm text-slate-600">{children}</div>
        {footer && <div className="flex shrink-0 flex-wrap justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}
