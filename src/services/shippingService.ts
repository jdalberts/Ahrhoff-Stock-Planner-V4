import { TransitContainer } from '../../types';

export interface ShippingTrackerData {
  vesselName?: string;
  destinationPort?: string;
  etaIso?: string;
  lastPosition?: { lat: number; lon: number };
  lastUpdatedIso?: string;
  shippingStatus?: 'At sea' | 'In port' | 'Arrived' | 'Unknown';
}

interface ShippingCacheEntry {
  cachedAt: number;
  data: ShippingTrackerData;
}

const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_PREFIX = 'shipping_tracker_cache_v1_';
const memoryCache = new Map<string, ShippingCacheEntry>();

const getCacheKey = (container: TransitContainer): string | null => {
  const imo = container.vesselIMO?.trim();
  if (imo) return `imo:${imo}`;
  const containerNumber = container.containerNumber?.trim();
  if (containerNumber) return `container:${containerNumber}`;
  return null;
};

const readFromStorage = (key: string): ShippingCacheEntry | null => {
  try {
    const raw = window.localStorage.getItem(`${CACHE_PREFIX}${key}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ShippingCacheEntry;
    if (!parsed || typeof parsed.cachedAt !== 'number' || !parsed.data) return null;
    return parsed;
  } catch {
    return null;
  }
};

const writeToStorage = (key: string, entry: ShippingCacheEntry) => {
  try {
    window.localStorage.setItem(`${CACHE_PREFIX}${key}`, JSON.stringify(entry));
  } catch {
    // Keep cache best-effort; storage can fail in private mode or quota limits.
  }
};

const readCache = (key: string): ShippingCacheEntry | null => {
  const fromMemory = memoryCache.get(key);
  if (fromMemory) return fromMemory;
  const fromStorage = readFromStorage(key);
  if (fromStorage) memoryCache.set(key, fromStorage);
  return fromStorage;
};

const writeCache = (key: string, data: ShippingTrackerData) => {
  const entry: ShippingCacheEntry = { cachedAt: Date.now(), data };
  memoryCache.set(key, entry);
  writeToStorage(key, entry);
};

const isFresh = (entry: ShippingCacheEntry): boolean => Date.now() - entry.cachedAt <= CACHE_TTL_MS;

const fetchProxy = async (path: string): Promise<ShippingTrackerData> => {
  const response = await fetch(path, { method: 'GET' });
  if (!response.ok) {
    let detail = '';
    try {
      const payload = await response.json();
      detail = payload?.detail || payload?.error || '';
    } catch {
      // Ignore JSON parse errors; fallback to status text.
    }
    const suffix = detail || response.statusText || `HTTP ${response.status}`;
    throw new Error(`Unable to fetch shipping data: ${suffix}`);
  }
  return response.json();
};

export const getMarineTrafficMapUrl = (container: TransitContainer): string => {
  const imo = container.vesselIMO?.trim();
  if (!imo) return 'https://www.marinetraffic.com/';
  return `https://www.marinetraffic.com/en/ais/details/ships/imo:${encodeURIComponent(imo)}`;
};

export const fetchShippingForContainer = async (
  container: TransitContainer,
  options?: { forceRefresh?: boolean },
): Promise<ShippingTrackerData | null> => {
  const imo = container.vesselIMO?.trim();
  const containerNumber = container.containerNumber?.trim();
  const key = getCacheKey(container);

  if (!key || (!imo && !containerNumber)) {
    return null;
  }

  if (!options?.forceRefresh) {
    const cached = readCache(key);
    if (cached && isFresh(cached)) {
      return cached.data;
    }
  }

  const query = imo
    ? `imo=${encodeURIComponent(imo)}`
    : `containerNumber=${encodeURIComponent(containerNumber as string)}`;
  const [voyageResult, positionResult] = await Promise.allSettled([
    fetchProxy(`/api/shipping/vessel-voyage?${query}`),
    fetchProxy(`/api/shipping/vessel-position?${query}`),
  ]);

  const voyage = voyageResult.status === 'fulfilled' ? voyageResult.value : {};
  const position = positionResult.status === 'fulfilled' ? positionResult.value : {};

  if (voyageResult.status === 'rejected' && positionResult.status === 'rejected') {
    throw new Error(voyageResult.reason?.message || positionResult.reason?.message || 'Unable to fetch shipping data');
  }

  const merged: ShippingTrackerData = {
    vesselName: voyage.vesselName || position.vesselName,
    destinationPort: voyage.destinationPort || position.destinationPort,
    etaIso: voyage.etaIso || position.etaIso,
    lastPosition: position.lastPosition || voyage.lastPosition,
    lastUpdatedIso: position.lastUpdatedIso || voyage.lastUpdatedIso,
    shippingStatus: position.shippingStatus || voyage.shippingStatus || 'Unknown',
  };

  writeCache(key, merged);
  return merged;
};
