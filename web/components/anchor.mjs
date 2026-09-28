// Where a floating list sits, measured from the field it belongs to.
//
// A dropdown positioned `absolute` inside its field is clipped by any ancestor that
// scrolls - a dialog, or a card on a phone, which scrolls sideways so a wide table
// does not widen the page. The list is therefore `fixed`, placed from the anchor's
// on-screen box, and re-placed whenever anything scrolls or the window resizes, so
// it follows the field instead of floating where the field used to be.
//
// It opens upward when the space below the anchor will not hold it and there is
// more room above, which is the difference between a list near the bottom of the
// screen and one that runs off it.
import { useState, useLayoutEffect } from '../lib.mjs';

const GAP = 4;

export function useAnchor(anchorRef, open, height = 280) {
  const [style, setStyle] = useState(null);

  useLayoutEffect(() => {
    if (!open) {
      setStyle(null);
      return undefined;
    }
    const place = () => {
      const el = anchorRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const below = window.innerHeight - r.bottom;
      const up = below < height + GAP && r.top > below;
      setStyle({
        position: 'fixed',
        left: `${Math.round(r.left)}px`,
        minWidth: `${Math.round(r.width)}px`,
        // Never past the right edge of the window, whatever the options' labels are.
        maxWidth: `${Math.max(Math.round(r.width), Math.round(window.innerWidth - r.left - 8))}px`,
        top: up ? 'auto' : `${Math.round(r.bottom + GAP)}px`,
        bottom: up ? `${Math.round(window.innerHeight - r.top + GAP)}px` : 'auto',
        maxHeight: `${Math.max(120, Math.min(height, Math.round((up ? r.top : below) - GAP * 3)))}px`,
      });
    };
    place();
    // Capture, so a scroll inside any container - not only the page - re-places it.
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open, anchorRef, height]);

  return style;
}
