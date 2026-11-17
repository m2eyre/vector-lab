/**
 * Advertising hooks. NOTHING here loads an ad network. With no provider configured (the
 * default) every slot renders nothing and every request resolves immediately, so the game
 * behaves exactly as it does without ads.
 *
 * To add ads later: implement AdProvider for your network, call registerAdProvider() at
 * start-up, and the three placements below light up. The manager, not the provider, enforces
 * the rule that no ad may appear while a simulation is running.
 */
export type AdPlacement = 'menu-banner' | 'between-runs' | 'rewarded-cosmetic';

export interface AdProvider {
  readonly name: string;
  /** Mount a banner into the element; return a cleanup function. */
  mountBanner(el: HTMLElement, placement: AdPlacement): () => void;
  /** Full-screen ad between activities. Resolves when it is closed. */
  showInterstitial(placement: AdPlacement): Promise<void>;
  /** Opt-in ad. Resolves true only if the player earned the reward. */
  showRewarded(placement: AdPlacement): Promise<boolean>;
  readonly rewardedAvailable: boolean;
}

class AdManager {
  private provider: AdProvider | null = null;
  private simulationActive = false;
  private lastInterstitial = 0;
  private listeners = new Set<() => void>();
  /** Minimum gap between interstitials, so finishing levels quickly never means an ad every level. */
  minInterstitialGapMs = 180_000;

  register(provider: AdProvider | null): void { this.provider = provider; this.listeners.forEach((l) => l()); }
  subscribe = (l: () => void): (() => void) => { this.listeners.add(l); return () => this.listeners.delete(l); };
  get configured(): boolean { return this.provider !== null; }
  get providerName(): string | null { return this.provider?.name ?? null; }
  get rewardedAvailable(): boolean { return !!this.provider?.rewardedAvailable && !this.simulationActive; }

  /** The game screen reports when a simulation is running; ads are refused for that whole time. */
  setSimulationActive(active: boolean): void { this.simulationActive = active; }
  canShow(): boolean { return this.provider !== null && !this.simulationActive; }

  mountBanner(el: HTMLElement, placement: AdPlacement): () => void {
    if (!this.provider) return () => {};
    return this.provider.mountBanner(el, placement);
  }

  /** Returns true if an ad was actually shown. Never throws and never blocks when unconfigured. */
  async showInterstitial(placement: AdPlacement, now = Date.now()): Promise<boolean> {
    if (!this.canShow() || now - this.lastInterstitial < this.minInterstitialGapMs) return false;
    this.lastInterstitial = now;
    try { await this.provider!.showInterstitial(placement); return true; } catch { return false; }
  }

  async showRewarded(placement: AdPlacement): Promise<boolean> {
    if (!this.canShow() || !this.provider!.rewardedAvailable) return false;
    try { return await this.provider!.showRewarded(placement); } catch { return false; }
  }
}

export const ads = new AdManager();
export function registerAdProvider(provider: AdProvider | null): void { ads.register(provider); }

/**
 * Development stand-in, enabled only by VITE_ADS_PROVIDER=placeholder. It draws clearly
 * labelled boxes so layouts and reward flows can be tested. It shows no real advertising
 * and loads no third-party script.
 */
export class PlaceholderAdProvider implements AdProvider {
  readonly name = 'placeholder';
  readonly rewardedAvailable = true;
  mountBanner(el: HTMLElement): () => void {
    const box = document.createElement('div');
    box.className = 'ad-placeholder';
    box.textContent = 'Ad placeholder · no ad network configured';
    el.appendChild(box);
    return () => box.remove();
  }
  private overlay(text: string, seconds: number): Promise<void> {
    return new Promise((resolve) => {
      const o = document.createElement('div');
      o.className = 'ad-overlay';
      o.setAttribute('role', 'dialog');
      o.innerHTML = '<div class="ad-overlay-card"><span class="eyebrow">Ad placeholder</span><strong></strong><small>No ad network is configured. This is a layout test.</small><button class="btn">Close</button></div>';
      o.querySelector('strong')!.textContent = text;
      const btn = o.querySelector('button')!;
      const done = () => { o.remove(); resolve(); };
      btn.addEventListener('click', done);
      document.body.appendChild(o);
      window.setTimeout(done, seconds * 1000);
    });
  }
  showInterstitial(): Promise<void> { return this.overlay('Interstitial slot', 4); }
  async showRewarded(): Promise<boolean> { await this.overlay('Rewarded slot', 3); return true; }
}

export function configureAdsFromEnv(): void {
  const name = ((import.meta as any).env ?? {}).VITE_ADS_PROVIDER as string | undefined;
  if (name === 'placeholder' && typeof document !== 'undefined') registerAdProvider(new PlaceholderAdProvider());
}
