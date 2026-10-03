import { useLayoutEffect, useRef, useState, CSSProperties } from 'react';

const MARGIN = 4; // keep this far from the window edges
const SUBMENU_WIDTH = 320; // .context-menu-submenu max-width (the Global Var submenu can be wide)

/**
 * Positions a right-click menu at the cursor but keeps it fully inside the window.
 * The menu's real size is measured before paint (no flicker):
 * - Near the bottom it opens upward from the cursor (like Windows), or is pinned to the bottom edge.
 * - Near the right edge it shifts left, and submenus open to the left instead.
 * - A menu taller than the window gets a scrollbar.
 */
export function useMenuPosition(anchor: { x: number; y: number } | null) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight?: number; flipSubmenu: boolean } | null>(null);

  useLayoutEffect(() => {
    if (!anchor || !ref.current) {
      setPos(null);
      return;
    }
    const { width, height } = ref.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left = anchor.x;
    if (left + width > vw - MARGIN) left = Math.max(MARGIN, vw - width - MARGIN);

    let top = anchor.y;
    let maxHeight: number | undefined;
    if (height > vh - 2 * MARGIN) {
      top = MARGIN;
      maxHeight = vh - 2 * MARGIN;
    } else if (top + height > vh - MARGIN) {
      const above = anchor.y - height;
      top = above >= MARGIN ? above : vh - height - MARGIN;
    }

    setPos({ top, left, maxHeight, flipSubmenu: left + width + SUBMENU_WIDTH > vw - MARGIN });
  }, [anchor?.x, anchor?.y]);

  const style: CSSProperties = pos
    ? {
        top: pos.top,
        left: pos.left,
        ...(pos.maxHeight !== undefined ? { maxHeight: pos.maxHeight, overflowY: 'auto' } : {}),
      }
    : // First render: measure off-screen-safe at the cursor, hidden until placed
      { top: anchor?.y ?? 0, left: anchor?.x ?? 0, visibility: 'hidden' };

  return { ref, style, submenuClass: pos?.flipSubmenu ? 'context-menu-submenu flip-left' : 'context-menu-submenu' };
}
