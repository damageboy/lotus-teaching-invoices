import { useEffect, useState } from 'react';

export type AppLayout = 'desktop' | 'mobile';

const MOBILE_QUERY = '(max-width: 767px)';

export function useCompactLayout(): boolean {
  const [compact, setCompact] = useState(() =>
    typeof window === 'undefined' || typeof window.matchMedia !== 'function'
      ? false
      : window.matchMedia(MOBILE_QUERY).matches
  );

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;

    const media = window.matchMedia(MOBILE_QUERY);
    const update = () => setCompact(media.matches);
    update();

    if (media.addEventListener) {
      media.addEventListener('change', update);
      return () => media.removeEventListener('change', update);
    }

    media.addListener(update);
    return () => media.removeListener(update);
  }, []);

  return compact;
}
