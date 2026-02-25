import { ShippingStatus } from '../types';

const MARINETRAFFIC_BASE_URL = 'https://services.marinetraffic.com';

const MARINETRAFFIC_ENDPOINTS = {
  vesselVoyage: '/api/exportvessel/v:8',
  vesselPosition: '/api/exportvesseltrack/v:2',
};

export interface NormalizedShippingData {
  vesselName?: string;
  destinationPort?: string;
  etaIso?: string;
  lastPosition?: { lat: number; lon: number };
  lastUpdatedIso?: string;
  shippingStatus?: ShippingStatus;
}

export interface ShippingLookup {
  imo?: string;
  containerNumber?: string;
}

const mapStatus = (rawStatus?: string): ShippingStatus => {
  const v = (rawStatus || '').toLowerCase();
  if (!v) return 'Unknown';
  if (v.includes('arriv')) return 'Arrived';
  if (v.includes('port') || v.includes('bert')) return 'In port';
  if (v.includes('sea') || v.includes('sail') || v.includes('way')) return 'At sea';
  return 'Unknown';
};

const toIso = (value?: string): string | undefined => {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString();
};

const buildMarineTrafficUrl = (
  endpoint: keyof typeof MARINETRAFFIC_ENDPOINTS,
  apiKey: string,
  lookup: ShippingLookup,
): string => {
  const path = MARINETRAFFIC_ENDPOINTS[endpoint];
  const query = new URLSearchParams({
    protocol: 'jsono',
  });
  if (lookup.imo) query.set('imo', lookup.imo);
  if (lookup.containerNumber) query.set('container', lookup.containerNumber);
  return `${MARINETRAFFIC_BASE_URL}${path}/${apiKey}?${query.toString()}`;
};

const fetchMarineTraffic = async (url: string): Promise<any[]> => {
  const response = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`MarineTraffic request failed (${response.status})`);
  }

  const data = await response.json();
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.data)) return data.data;
  return [];
};

const normalizeVoyage = (rows: any[]): NormalizedShippingData => {
  const row = rows[0] || {};
  return {
    vesselName: row.SHIPNAME || row.VESSEL_NAME || row.SHIP_NAME || undefined,
    destinationPort: row.DESTINATION || row.DEST_PORT || row.PORT_NAME || undefined,
    etaIso: toIso(row.ETA || row.ETA_UTC || row.ETA_TS),
    shippingStatus: mapStatus(row.STATUS || row.NAV_STATUS || row.VOYAGE_STATUS),
  };
};

const normalizePosition = (rows: any[]): NormalizedShippingData => {
  const row = rows[0] || {};
  const lat = Number(row.LAT || row.LATITUDE);
  const lon = Number(row.LON || row.LONGITUDE);
  const hasPosition = Number.isFinite(lat) && Number.isFinite(lon);

  return {
    lastPosition: hasPosition ? { lat, lon } : undefined,
    lastUpdatedIso: toIso(row.TIMESTAMP || row.LAST_RECEIVED || row.LAST_UPDATED || row.POSITION_TIMESTAMP),
    shippingStatus: mapStatus(row.STATUS || row.NAV_STATUS || row.VOYAGE_STATUS),
  };
};

export const fetchVesselVoyage = async (lookup: ShippingLookup, apiKey: string): Promise<NormalizedShippingData> => {
  if (!lookup.imo && !lookup.containerNumber) return {};
  const url = buildMarineTrafficUrl('vesselVoyage', apiKey, lookup);
  const rows = await fetchMarineTraffic(url);
  return normalizeVoyage(rows);
};

export const fetchVesselPosition = async (lookup: ShippingLookup, apiKey: string): Promise<NormalizedShippingData> => {
  if (!lookup.imo && !lookup.containerNumber) return {};
  const url = buildMarineTrafficUrl('vesselPosition', apiKey, lookup);
  const rows = await fetchMarineTraffic(url);
  return normalizePosition(rows);
};

export const fetchShippingSnapshot = async (lookup: ShippingLookup, apiKey: string): Promise<NormalizedShippingData> => {
  const [voyage, position] = await Promise.all([
    fetchVesselVoyage(lookup, apiKey),
    fetchVesselPosition(lookup, apiKey),
  ]);

  return {
    vesselName: voyage.vesselName,
    destinationPort: voyage.destinationPort,
    etaIso: voyage.etaIso,
    lastPosition: position.lastPosition,
    lastUpdatedIso: position.lastUpdatedIso,
    shippingStatus: position.shippingStatus || voyage.shippingStatus || 'Unknown',
  };
};
