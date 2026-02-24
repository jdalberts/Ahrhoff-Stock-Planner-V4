export interface ProductAliasEntry {
  canonical: string;
  aliases: string[];
}

export interface ProductNormalizationResult {
  canonical: string;
  matchedAlias: string;
  matched: boolean;
}

export interface PackInfo {
  packCount?: number;
  packSize?: number;
  packUom?: string;
  packType?: string;
  derivedKg?: number;
}

const PRODUCT_CATALOG: ProductAliasEntry[] = [
  { canonical: 'Browser Steam Up 20', aliases: ['Steam Up 20', 'SteamUp 20', 'Steam-up 20', 'Browser SteamUp', 'Browser Steam Up'] },
  { canonical: 'Browser K6 Pro', aliases: ['K6 Pro', 'Browser K6', 'K6Pro'] },
  { canonical: 'Browser K60 A2', aliases: ['K60 A2', 'K60A2', 'Browser K60', 'K60'] },
  { canonical: 'Browser DryLac FL', aliases: ['DryLac FL', 'Drylac', 'Browser DryLac', 'DryLac'] },
  { canonical: 'Browser Silage Cool', aliases: ['Silage Cool', 'SilageCool', 'Browser SilageCool', 'Silage inoculant'] },
  { canonical: 'Browser Beef Pro', aliases: ['Beef Pro', 'BeefPro', 'Browser BeefPro'] },
  { canonical: 'Clex Pro Drink', aliases: ['Pro Drink', 'ProDrink', 'Clex Prodrink', 'Clex Pro Drink'] },
  { canonical: 'Clex Green Drink', aliases: ['Green Drink', 'Greendrink', 'Clex Green', 'GreenDrink'] },
  { canonical: 'Clex Eukatol', aliases: ['Eukatol', 'Clex Euka', 'EukaTol'] },
  { canonical: 'Clex SECH 3 Drink', aliases: ['SECH 3', 'Sech 3', 'Secgh 3', 'Clex Sech 3', 'SECH3'] },
  { canonical: 'Clex V Hefe 4', aliases: ['V Hefe 4', 'VHefe4', 'V-Hefe', 'V Hefe'] },
];

const normalizeKey = (value: string): string => {
  return (value || '')
    .toLowerCase()
    .replace(/[®™]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
};

interface AliasCandidate {
  canonical: string;
  alias: string;
  key: string;
  score: number;
}

const ALIAS_CANDIDATES: AliasCandidate[] = PRODUCT_CATALOG.flatMap(entry => {
  const allAliases = [entry.canonical, ...entry.aliases];
  return allAliases.map(alias => ({
    canonical: entry.canonical,
    alias,
    key: normalizeKey(alias),
    score: normalizeKey(alias).length,
  }));
});

export const CANONICAL_PRODUCT_NAMES = PRODUCT_CATALOG.map(entry => entry.canonical);

export const normalizeProductName = (raw: string): ProductNormalizationResult => {
  const source = normalizeKey(raw);
  if (!source) {
    return { canonical: raw, matchedAlias: '', matched: false };
  }

  const matches = ALIAS_CANDIDATES.filter(candidate => {
    if (!candidate.key) return false;
    return source.includes(candidate.key) || candidate.key.includes(source);
  }).sort((a, b) => b.score - a.score);

  if (matches.length === 0) {
    return { canonical: raw, matchedAlias: '', matched: false };
  }

  const best = matches[0];
  return {
    canonical: best.canonical,
    matchedAlias: best.alias,
    matched: true,
  };
};

export const parsePackInfo = (memo: string): PackInfo => {
  const input = memo || '';
  const compact = input.replace(/,/g, '');

  const pattern = /(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)\s*([a-zA-Z]{1,6})?\s*(bags?|bag|canisters?|canister|sacks?|sack|drums?|drum)?/i;
  const match = compact.match(pattern);

  if (!match) return {};

  const packCount = Number(match[1]);
  const packSize = Number(match[2]);
  const packUom = (match[3] || '').toLowerCase();
  const packType = (match[4] || '').toLowerCase();

  const result: PackInfo = {
    packCount: Number.isFinite(packCount) ? packCount : undefined,
    packSize: Number.isFinite(packSize) ? packSize : undefined,
    packUom: packUom || undefined,
    packType: packType || undefined,
  };

  if (result.packCount && result.packSize && result.packUom === 'kg') {
    result.derivedKg = result.packCount * result.packSize;
  }

  return result;
};

export const isCreditDocument = (docType: string): boolean => {
  const normalized = normalizeKey(docType);
  return normalized.includes('credit') || normalized.includes('refund');
};
