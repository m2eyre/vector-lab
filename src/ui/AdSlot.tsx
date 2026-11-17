import { useEffect, useRef } from 'react';
import { AdPlacement, ads } from '../services/ads';
import { useAdsConfigured } from './hooks';

/**
 * A place where a banner may appear. Renders nothing at all unless an ad provider has been
 * registered (see services/ads.ts). It is only ever used on menu screens, never in the game.
 */
export function AdSlot({ placement }: { placement: AdPlacement }) {
  const configured = useAdsConfigured();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!configured || !ref.current) return;
    return ads.mountBanner(ref.current, placement);
  }, [configured, placement]);
  if (!configured) return null;
  return <div ref={ref} className="ad-slot" data-placement={placement} aria-label="Advertisement" />;
}
