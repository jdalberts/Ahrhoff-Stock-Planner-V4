import { Settings } from './types';

export const DEFAULT_SETTINGS: Settings = {
  defaultLeadTimeDays: 14,
  safetyStockDays: 7,
  reviewPeriodDays: 7,
  lowStockDaysCoverThreshold: 21,
  expiryWarningDays: 60,
  notificationCooldownHours: 24,
  currencySymbol: 'R',
  whatsappMode: 'clickToWhatsApp',
  whatsappNumber: '',
  whatsappRecipients: [],
  forecastMethod: 'simpleAverage6Months',
  weights: [1, 1, 1, 1, 1, 5],
  lowStockRule: 'belowDaysCover',
};

export const CATEGORIES = ['Clex', 'Browser', 'Segawean', 'Other'];
export const LOT_STATUSES = ['available', 'expired', 'damaged'] as const;
export const COUNT_REASONS = ['adjustment', 'damage', 'correction', 'routine'] as const;
export const FORECAST_METHODS = [
  { value: 'simpleAverage6Months', label: 'Simple 6-Month Average' },
  { value: 'weightedAverage', label: 'Weighted Average' }
] as const;
export const LOW_STOCK_RULES = [
  { value: 'belowDaysCover', label: 'Below Days Cover' },
  { value: 'belowReorderPoint', label: 'Below Reorder Point' }
] as const;
