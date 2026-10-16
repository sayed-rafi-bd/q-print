import type { KeyboardEvent } from 'react';

/**
 * Arrow-key movement for a `role="tablist"`, as the ARIA tabs pattern describes it: Left/Right move
 * to the neighbouring tab (wrapping), Home/End jump to the ends, and the tab that gets focus is
 * selected. Pair it with `tabIndex={selected ? 0 : -1}` on each tab, so Tab leaves the list in one
 * stop instead of walking through every tab.
 *
 * `ids` are the tab ids in order and `select` is the same function the click handler uses.
 */
export function tabListKeyDown<T extends string>(
  e: KeyboardEvent<HTMLElement>,
  ids: readonly T[],
  current: T,
  select: (id: T) => void,
) {
  const at = ids.indexOf(current);
  let next: number;
  switch (e.key) {
    case 'ArrowRight':
      next = (at + 1) % ids.length;
      break;
    case 'ArrowLeft':
      next = (at - 1 + ids.length) % ids.length;
      break;
    case 'Home':
      next = 0;
      break;
    case 'End':
      next = ids.length - 1;
      break;
    default:
      return;
  }
  e.preventDefault();
  select(ids[next]);
  // The newly selected tab is the one the list should be focused on. It is found by its role rather
  // than by index, so any extra markup inside the list cannot throw the count off.
  const tabs = e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]');
  tabs[next]?.focus();
}
