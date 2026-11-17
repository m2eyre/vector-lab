import { useEffect, useState, useSyncExternalStore } from 'react';
import { GameController } from '../game/controller';
import { profile, SaveData } from '../services/storage';

export function useProfile(): SaveData {
  return useSyncExternalStore(profile.subscribe, profile.get, profile.get);
}

/** Re-render whenever the controller reports a state change. */
export function useController(c: GameController): number {
  return useSyncExternalStore(c.subscribe, c.getVersion, c.getVersion);
}

/** Low-frequency polling for values that change every physics step (timer, energy). */
export function useTicker(active: boolean, hz = 12): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setN((x) => x + 1), 1000 / hz);
    return () => window.clearInterval(id);
  }, [active, hz]);
  return n;
}

import { ads } from '../services/ads';
import { online, OnlineState } from '../services/online';

export function useOnline(): OnlineState {
  return useSyncExternalStore(online.subscribe, online.getState, online.getState);
}

/** Re-render when an ad provider is registered. */
export function useAdsConfigured(): boolean {
  return useSyncExternalStore(ads.subscribe, () => ads.configured, () => ads.configured);
}
