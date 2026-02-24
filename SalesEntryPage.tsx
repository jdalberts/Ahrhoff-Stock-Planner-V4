import React, { useEffect, useMemo, useState } from 'react';
import { ImportBatchV5, Item, OrderLineV5, OrderV5, SalesHistory } from './types';
import { db } from './db';
import { TrendingUp, Search } from 'lucide-react';
import { isCreditDocument } from './productNormalization';
import { CATEGORIES } from './constants';

interface Props {
  items: Item[];
  sales: SalesHistory[];
  onRefresh: () => void;
}

interface SyncSummary {
  at: string;
  scopeLabel: string;
  dateMode: string;
  anchorMonth: string;
  months: string[];
  totalOrders: number;
  totalLines: number;
  linesInWindow: number;
  matchedLines: number;
  unmatchedLines: number;
  createdItems: number;
  updatedSalesRows: number;
  unmatchedProductSamples: string[];
}

const SalesEntry: React.FC<Props> = ({ items, sales, onRefresh }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [tempSales, setTempSales] = useState<Record<string, string>>({});
  const [isSyncingFromOrders, setIsSyncingFromOrders] = useState(false);
  const [hasAutoSynced, setHasAutoSynced] = useState(false);
  const [syncSummary, setSyncSummary] = useState<SyncSummary | null>(null);
  const currentMonth = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;

  const getRecentMonthKeys = (anchor: string) => {
    const [anchorYear, anchorMonthPart] = anchor.split('-').map(Number);
    const baseDate = Number.isFinite(anchorYear) && Number.isFinite(anchorMonthPart)
      ? new Date(anchorYear, anchorMonthPart - 1, 1)
      : new Date();

    const months: string[] = [];
    for (let i = 0; i < 6; i++) {
      const d = new Date(baseDate.getFullYear(), baseDate.getMonth() - i, 1);
      months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }
    return months.reverse();
  };

  const getDataDrivenMonthKeys = (orders: OrderV5[]): string[] => {
    const unique = [...new Set(
      orders
        .map(order => (order.docDate || '').slice(0, 7))
        .filter(month => /^\d{4}-\d{2}$/.test(month))
    )].sort();

    if (unique.length >= 6) return unique.slice(-6);
    if (unique.length > 0) return unique;
    return [currentMonth];
  };

  const monthKeys = useMemo(() => {
    const uniqueMonths = [...new Set(
      sales
        .map(row => row.month)
        .filter(month => /^\d{4}-\d{2}$/.test(month))
    )].sort();

    if (uniqueMonths.length >= 6) return uniqueMonths.slice(-6);
    if (uniqueMonths.length > 0) return uniqueMonths;
    return [currentMonth];
  }, [sales, currentMonth]);

  const normalizeKey = (value: string): string => {
    return (value || '')
      .toLowerCase()
      .replace(/[®™]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  };

  const parseIsoParts = (value: string): { year: number; month: number; day: number } | null => {
    const match = (value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return { year, month, day };
  };

  const normalizeOrderDate = (value: string, swapAmbiguous: boolean): string => {
    const parsed = parseIsoParts(value);
    if (!parsed) return value;
    const { year, month, day } = parsed;

    if (swapAmbiguous && month <= 12 && day <= 12) {
      return `${year.toString().padStart(4, '0')}-${String(day).padStart(2, '0')}-${String(month).padStart(2, '0')}`;
    }

    return `${year.toString().padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  };

  const latestDateValue = (orders: OrderV5[], swapAmbiguous: boolean): number => {
    let latest = Number.NEGATIVE_INFINITY;
    for (const order of orders) {
      const normalized = normalizeOrderDate(order.docDate || '', swapAmbiguous);
      const dt = new Date(normalized);
      if (Number.isNaN(dt.getTime())) continue;
      latest = Math.max(latest, dt.getTime());
    }
    return latest;
  };

  const shouldSwapAmbiguousDates = (orders: OrderV5[]): boolean => {
    const ambiguousCount = orders.reduce((count, order) => {
      const parsed = parseIsoParts(order.docDate || '');
      if (!parsed) return count;
      return parsed.month <= 12 && parsed.day <= 12 ? count + 1 : count;
    }, 0);

    if (ambiguousCount === 0) return false;

    const now = new Date();
    const oneMonthAhead = new Date(now.getFullYear(), now.getMonth() + 1, now.getDate()).getTime();
    const latestAsIs = latestDateValue(orders, false);
    const latestSwapped = latestDateValue(orders, true);

    return latestAsIs > oneMonthAhead && latestSwapped <= oneMonthAhead;
  };

  const resolveItemIdForOrderLine = (line: OrderLineV5, itemKeyMap: Map<string, string>): string | null => {
    const lineNames = [line.productNameNormalized, line.productNameRaw].filter(Boolean) as string[];

    for (const rawName of lineNames) {
      const key = normalizeKey(rawName);
      if (!key) continue;

      const exact = itemKeyMap.get(key);
      if (exact) return exact;

      for (const [itemKey, itemId] of itemKeyMap.entries()) {
        if (key.includes(itemKey) || itemKey.includes(key)) return itemId;
      }
    }

    return null;
  };

  const inferCategory = (name: string): Item['category'] => {
    const n = name.toLowerCase();
    if (n.startsWith('browser')) return CATEGORIES[1] as Item['category'];
    if (n.startsWith('clex')) return CATEGORIES[0] as Item['category'];
    if (n.startsWith('segawean')) return CATEGORIES[2] as Item['category'];
    return CATEGORIES[3] as Item['category'];
  };

  const syncDemandFromSalesOrders = async () => {
    setIsSyncingFromOrders(true);
    try {
      const [orders, orderLines] = await Promise.all([
        db.getAll<OrderV5>('orders'),
        db.getAll<OrderLineV5>('order_lines'),
      ]);

      const batches = await db.getAll<ImportBatchV5>('import_batches');
      const latestBatch = [...batches].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] || null;

      let scopedOrders = orders;
      let scopeLabel = 'All Orders';

      if (latestBatch) {
        const latestBatchOrders = orders.filter(order => order.importBatchId === latestBatch.id);
        if (latestBatchOrders.length > 0) {
          scopedOrders = latestBatchOrders;
          scopeLabel = `Latest Import: ${latestBatch.fileName}`;
        }
      }

      const scopedOrderIds = new Set(scopedOrders.map(order => order.id));
      const scopedOrderLines = orderLines.filter(line => scopedOrderIds.has(line.orderId));

      const swapAmbiguousDates = shouldSwapAmbiguousDates(scopedOrders);
      const dateMode = swapAmbiguousDates ? 'Corrected DD/MM from stored YYYY-DD-MM' : 'Used stored YYYY-MM-DD';
      const effectiveOrders: OrderV5[] = scopedOrders.map(order => ({
        ...order,
        docDate: normalizeOrderDate(order.docDate || '', swapAmbiguousDates),
      }));

      const orderMap = new Map<string, OrderV5>();
      for (const order of effectiveOrders) orderMap.set(order.id, order);

      const latestOrderDate = effectiveOrders
        .map(order => order.docDate)
        .filter(Boolean)
        .sort()
        .at(-1);

      const nextAnchorMonth = latestOrderDate ? latestOrderDate.slice(0, 7) : currentMonth;
      const targetMonths = getDataDrivenMonthKeys(effectiveOrders);

      const itemKeyMap = new Map<string, string>();
      for (const item of items) {
        itemKeyMap.set(normalizeKey(item.name), item.id);
      }

      const missingProducts = new Map<string, string>();
      for (const line of scopedOrderLines) {
        const existingItemId = resolveItemIdForOrderLine(line, itemKeyMap);
        if (existingItemId) continue;

        const preferredName = (line.productNameNormalized || line.productNameRaw || '').trim();
        const productKey = normalizeKey(preferredName);
        if (!productKey || missingProducts.has(productKey)) continue;
        missingProducts.set(productKey, preferredName || 'Unknown Product');
      }

      for (const [productKey, productName] of missingProducts.entries()) {
        const autoId = `auto_${productKey.replace(/\s+/g, '_')}`;
        const autoItem: Item = {
          id: autoId,
          skuCode: `AUTO-${productKey.replace(/\s+/g, '-').toUpperCase().slice(0, 24)}`,
          name: productName,
          category: inferCategory(productName),
          packSize: 1,
          leadTimeDays: 60,
          moq: 1000,
          costPerUnit: 0,
        };
        await db.put('items', autoItem);
        itemKeyMap.set(productKey, autoId);
      }

      let linesInWindow = 0;
      let matchedLines = 0;
      let unmatchedLines = 0;
      const unmatchedProducts = new Set<string>();

      const aggregatedQty = new Map<string, number>();

      for (const line of scopedOrderLines) {
        const order = orderMap.get(line.orderId);
        if (!order?.docDate) continue;

        const month = order.docDate.slice(0, 7);
        if (!targetMonths.includes(month)) continue;
        linesInWindow += 1;

        const itemId = resolveItemIdForOrderLine(line, itemKeyMap);
        if (!itemId) {
          unmatchedLines += 1;
          const sampleName = (line.productNameNormalized || line.productNameRaw || '').trim();
          if (sampleName) unmatchedProducts.add(sampleName);
          continue;
        }
        matchedLines += 1;

        const rawQty = Number(line.qty || 0);
        if (!Number.isFinite(rawQty)) continue;

        const signedQty = isCreditDocument(order.docType || '') ? -Math.abs(rawQty) : rawQty;
        const mapKey = `${itemId}_${month}`;
        aggregatedQty.set(mapKey, (aggregatedQty.get(mapKey) || 0) + signedQty);
      }

      const itemsForSync = await db.getAll<Item>('items');
      const updates: SalesHistory[] = [];
      for (const item of itemsForSync) {
        for (const month of targetMonths) {
          const id = `${item.id}_${month}`;
          updates.push({
            id,
            itemId: item.id,
            month,
            quantitySold: Number((aggregatedQty.get(id) || 0).toFixed(3)),
          });
        }
      }

      for (const update of updates) {
        await db.put('sales', update);
      }

      setSyncSummary({
        at: new Date().toISOString(),
        scopeLabel,
        dateMode,
        anchorMonth: nextAnchorMonth,
        months: targetMonths,
        totalOrders: scopedOrders.length,
        totalLines: scopedOrderLines.length,
        linesInWindow,
        matchedLines,
        unmatchedLines,
        createdItems: missingProducts.size,
        updatedSalesRows: updates.length,
        unmatchedProductSamples: [...unmatchedProducts].slice(0, 6),
      });

      await onRefresh();
    } finally {
      setIsSyncingFromOrders(false);
    }
  };

  useEffect(() => {
    if (hasAutoSynced) return;

    setHasAutoSynced(true);
    void syncDemandFromSalesOrders();
  }, [hasAutoSynced]);

  const handleEdit = (item: Item) => {
    setEditingItemId(item.id);
    const initialValues: Record<string, string> = {};
    monthKeys.forEach(m => {
      const existing = sales.find(s => s.itemId === item.id && s.month === m);
      initialValues[`${item.id}_${m}`] = existing?.quantitySold.toString() || '0';
    });
    setTempSales(initialValues);
  };

  const handleSave = async (itemId: string) => {
    const updates = monthKeys.map(m => ({
      id: `${itemId}_${m}`,
      itemId,
      month: m,
      quantitySold: Number(tempSales[`${itemId}_${m}`] || 0)
    }));

    for (const update of updates) {
      await db.put('sales', update);
    }

    setEditingItemId(null);
    onRefresh();
  };

  const filteredItems = items.filter(i =>
    i.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    i.skuCode.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="space-y-8">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-3xl font-bold text-slate-800 mb-2">Demand Forecast Entry</h2>
          <p className="text-slate-500">Populate the last 6 months from Sales / Orders and edit when needed.</p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => void syncDemandFromSalesOrders()}
            disabled={isSyncingFromOrders}
            className="px-4 py-2 bg-slate-800 text-white rounded-xl text-sm font-semibold disabled:opacity-50"
          >
            {isSyncingFromOrders ? 'Syncing…' : 'Sync from Sales / Orders'}
          </button>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
            <input
              type="text"
              placeholder="Search products..."
              className="pl-10 pr-4 py-2 border border-slate-200 rounded-xl focus:ring-2 focus:ring-green-600/20 w-64"
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
            />
          </div>
        </div>
      </div>

      {syncSummary && (
        <div className="bg-white rounded-2xl border border-slate-200 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <h3 className="text-sm font-semibold text-slate-800">Last Sync Summary</h3>
            <p className="text-xs text-slate-500">
              {new Date(syncSummary.at).toLocaleString()} · Window {syncSummary.months[0]} to {syncSummary.months[syncSummary.months.length - 1]} (anchor {syncSummary.anchorMonth})
            </p>
          </div>
          <p className="text-xs text-slate-600 mb-3">Source: {syncSummary.scopeLabel}</p>
          <p className="text-xs text-slate-600 mb-3">Date Mode: {syncSummary.dateMode}</p>
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-3 text-sm">
            <div className="p-3 rounded-lg bg-slate-50 border border-slate-100"><div className="text-xs text-slate-500">Orders</div><div className="font-bold text-slate-800">{syncSummary.totalOrders}</div></div>
            <div className="p-3 rounded-lg bg-slate-50 border border-slate-100"><div className="text-xs text-slate-500">Order Lines</div><div className="font-bold text-slate-800">{syncSummary.totalLines}</div></div>
            <div className="p-3 rounded-lg bg-slate-50 border border-slate-100"><div className="text-xs text-slate-500">Lines in Window</div><div className="font-bold text-slate-800">{syncSummary.linesInWindow}</div></div>
            <div className="p-3 rounded-lg bg-slate-50 border border-slate-100"><div className="text-xs text-slate-500">Matched Lines</div><div className="font-bold text-green-700">{syncSummary.matchedLines}</div></div>
            <div className="p-3 rounded-lg bg-slate-50 border border-slate-100"><div className="text-xs text-slate-500">Unmatched Lines</div><div className="font-bold text-amber-700">{syncSummary.unmatchedLines}</div></div>
            <div className="p-3 rounded-lg bg-slate-50 border border-slate-100"><div className="text-xs text-slate-500">New Items</div><div className="font-bold text-slate-800">{syncSummary.createdItems}</div></div>
            <div className="p-3 rounded-lg bg-slate-50 border border-slate-100"><div className="text-xs text-slate-500">Sales Rows Updated</div><div className="font-bold text-slate-800">{syncSummary.updatedSalesRows}</div></div>
          </div>
          {syncSummary.unmatchedProductSamples.length > 0 && (
            <div className="mt-3 text-xs text-slate-600">
              <span className="font-semibold text-slate-700">Unmatched products:</span> {syncSummary.unmatchedProductSamples.join(', ')}
            </div>
          )}
        </div>
      )}

      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-100">
                <th className="px-6 py-4 font-semibold text-slate-500 text-sm">Product</th>
                {monthKeys.map(m => (
                  <th key={m} className="px-4 py-4 font-semibold text-slate-500 text-sm text-center">{m}</th>
                ))}
                <th className="px-6 py-4 font-semibold text-slate-500 text-sm text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredItems.map(item => (
                <tr key={item.id} className="hover:bg-slate-50/50">
                  <td className="px-6 py-4">
                    <div className="font-bold text-slate-800">{item.name}</div>
                    <div className="text-xs text-slate-400">{item.skuCode}</div>
                  </td>
                  {monthKeys.map(m => {
                    const isEditing = editingItemId === item.id;
                    const val = isEditing
                      ? tempSales[`${item.id}_${m}`]
                      : sales.find(s => s.itemId === item.id && s.month === m)?.quantitySold || 0;

                    return (
                      <td key={m} className="px-4 py-4 text-center">
                        {isEditing ? (
                          <input
                            type="number"
                            className="w-20 px-2 py-1 text-center border border-slate-200 rounded focus:ring-2 focus:ring-green-600/20"
                            value={String(val ?? '')}
                            onChange={e => {
                              setTempSales(prev => ({ ...prev, [`${item.id}_${m}`]: e.target.value }));
                            }}
                            min={0}
                            step={1}
                          />
                        ) : (
                          <span className="text-slate-600 font-medium">{val}</span>
                        )}
                      </td>
                    );
                  })}
                  <td className="px-6 py-4 text-right">
                    {editingItemId === item.id ? (
                      <button
                        onClick={() => handleSave(item.id)}
                        className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-bold shadow-sm"
                      >
                        Save
                      </button>
                    ) : (
                      <button
                        onClick={() => handleEdit(item)}
                        className="text-slate-400 hover:text-blue-600 transition-colors"
                      >
                        <TrendingUp size={20} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export default SalesEntry;
