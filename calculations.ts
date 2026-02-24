import { InventoryAlert, InventoryLot, Item, ItemPlanningView, SalesHistory, Settings } from './types';

const toNumber = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const daysUntil = (dateIso: string): number => {
  const target = new Date(dateIso);
  const now = new Date();
  const diff = target.getTime() - now.getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24));
};

const monthlyDemand = (sales: SalesHistory[], itemId: string, settings: Settings): number => {
  const rows = sales
    .filter(s => s.itemId === itemId)
    .sort((a, b) => a.month.localeCompare(b.month))
    .slice(-6);

  if (rows.length === 0) return 0;

  if (settings.forecastMethod === 'weightedAverage' && settings.weights.length >= rows.length) {
    const weights = settings.weights.slice(-rows.length);
    const weighted = rows.reduce((sum, row, idx) => sum + toNumber(row.quantitySold) * weights[idx], 0);
    const totalWeight = weights.reduce((sum, weight) => sum + toNumber(weight), 0);
    if (totalWeight > 0) return weighted / totalWeight;
  }

  const total = rows.reduce((sum, row) => sum + toNumber(row.quantitySold), 0);
  return total / rows.length;
};

export function calculateItemPlanning(
  item: Item,
  allLots: InventoryLot[],
  allSales: SalesHistory[],
  settings: Settings
): ItemPlanningView {
  const lots = allLots.filter(l => l.itemId === item.id);
  const sales = allSales.filter(s => s.itemId === item.id);

  const availableStock = lots
    .filter(l => l.status === 'available')
    .reduce((sum, lot) => sum + Math.max(0, toNumber(lot.quantityRemaining)), 0);

  const avgMonthlyDemand = monthlyDemand(allSales, item.id, settings);
  const dailyDemand = avgMonthlyDemand > 0 ? avgMonthlyDemand / 30 : 0;
  const safetyStock = dailyDemand * toNumber(settings.safetyStockDays);
  const leadTimeDays = toNumber(item.leadTimeDays, settings.defaultLeadTimeDays);
  const reorderPoint = dailyDemand * leadTimeDays + safetyStock;
  const reviewDemand = dailyDemand * toNumber(settings.reviewPeriodDays);

  let suggestedOrderQty = Math.max(0, reorderPoint + reviewDemand - availableStock);
  const itemMoq = Math.max(1, toNumber(item.moq, 1));
  if (suggestedOrderQty > 0) {
    suggestedOrderQty = Math.ceil(suggestedOrderQty / itemMoq) * itemMoq;
  }

  const daysCover = dailyDemand > 0 ? availableStock / dailyDemand : Number.POSITIVE_INFINITY;

  const expiringSoonLots = lots.filter(lot => {
    if (!lot.expiryDate || lot.status !== 'available') return false;
    const days = daysUntil(lot.expiryDate);
    return days >= 0 && days <= settings.expiryWarningDays;
  });

  const lowStockFlag = settings.lowStockRule === 'belowReorderPoint'
    ? availableStock < reorderPoint
    : daysCover < settings.lowStockDaysCoverThreshold;

  const projectedDaysCoverAfterOrder = dailyDemand > 0
    ? (availableStock + suggestedOrderQty) / dailyDemand
    : Number.POSITIVE_INFINITY;

  return {
    item,
    lots,
    sales,
    availableStock,
    avgMonthlyDemand,
    dailyDemand,
    safetyStock,
    reorderPoint,
    suggestedOrderQty,
    projectedDaysCoverAfterOrder,
    daysCover,
    lowStockFlag,
    expiringSoonLots,
  };
}

export function detectAlerts(
  planningViews: ItemPlanningView[],
  _existingAlerts: InventoryAlert[],
  _settings: Settings
): InventoryAlert[] {
  const nowIso = new Date().toISOString();

  return planningViews.flatMap(view => {
    const alerts: InventoryAlert[] = [];

    if (view.lowStockFlag) {
      alerts.push({
        id: typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${view.item.id}_low_${Date.now()}`,
        createdAt: nowIso,
        itemId: view.item.id,
        type: 'lowStock',
        message: `${view.item.name} is below stock threshold (${Math.round(view.daysCover)} days cover).`,
        status: 'pending',
      });
    }

    if (view.expiringSoonLots.length > 0) {
      alerts.push({
        id: typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${view.item.id}_exp_${Date.now()}`,
        createdAt: nowIso,
        itemId: view.item.id,
        type: 'expiry',
        message: `${view.item.name} has ${view.expiringSoonLots.length} lot(s) expiring soon.`,
        status: 'pending',
      });
    }

    return alerts;
  });
}
