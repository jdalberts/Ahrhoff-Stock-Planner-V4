import React, { useState, useMemo, useEffect } from 'react';
import { Package, AlertTriangle, Info, Truck, Plus, Trash2, Pencil, RefreshCw, ExternalLink, ChevronDown, ChevronUp } from 'lucide-react';
import { LEAD_TIME_WEEKS, KG_PER_PALLET, PALLETS_PER_CONTAINER } from './productCatalog';
import { db } from './db';
import { Item, InventoryLot, SalesHistory, TransitContainer, TransitContainerLine, TransitContainerStatus } from './types';
import { fetchShippingForContainer, getMarineTrafficMapUrl, ShippingTrackerData } from './src/services/shippingService';

// ── Types ──
interface PlanRow {
  itemId: string;
  name: string;
  stock: number;
  inTransitStock: number;
  effectiveStock: number;
  avgMonthly: number;
  dailyDemand: number;
  seasonal: number;
  forecast8w: number;
  need: number;
  suggestedPallets: number;
  pallets: number;
  kg: number;
  shelfLife: number;
  shelfLifeMonths: number;
  shelfAlert: boolean;
  isOverride: boolean;
  status: 'overdue' | 'due_soon' | 'on_track';
  category: string;
}

// ── Helpers ──
function fmtKg(v: number): string {
  if (Math.abs(v) >= 1000) return (v / 1000).toFixed(1) + 't';
  return Math.round(v) + ' kg';
}

function fmtIsoDateTime(v?: string): string {
  if (!v) return '—';
  const parsed = new Date(v);
  if (Number.isNaN(parsed.getTime())) return v;
  return parsed.toLocaleString('en-ZA');
}
function getProductBase(
  items: Item[],
  lots: InventoryLot[],
  sales: SalesHistory[],
  inTransitByItem: Record<string, number>
) {
  const leadTimeDays = LEAD_TIME_WEEKS * 7;
  const reorderPointDays = leadTimeDays + 14;

  return items.map(item => {
    const itemSales = sales.filter(s => s.itemId === item.id);
    const uniqueMonths = [...new Set(itemSales.map(s => s.month))];
    const numMonths = uniqueMonths.length || 1;
    const totalSold = itemSales.reduce((a, b) => a + Number(b.quantitySold || 0), 0);
    const avgMonthly = totalSold / numMonths;
    const dailyDemand = avgMonthly / 30.4;
    const stock = lots
      .filter(l => l.itemId === item.id && l.status === 'available')
      .reduce((acc, lot) => acc + Number(lot.quantityRemaining || 0), 0);
    const inTransitStock = Math.max(0, Number(inTransitByItem[item.id] || 0));
    const effectiveStock = stock + inTransitStock;
    const daysCover = dailyDemand > 0 ? Math.min(effectiveStock / dailyDemand, 999) : 999;
    const shelfLife = item.shelfLifeDays || 365;
    let status: 'overdue' | 'due_soon' | 'on_track' = 'on_track';
    if (daysCover < leadTimeDays) status = 'overdue';
    else if (daysCover < reorderPointDays) status = 'due_soon';
    return {
      itemId: item.id,
      name: item.name,
      stock,
      inTransitStock,
      effectiveStock,
      avgMonthly,
      dailyDemand,
      shelfLife,
      shelfLifeMonths: Math.round(shelfLife / 30), status,
      category: item.category,
    };
  }).sort((a, b) => b.avgMonthly - a.avgMonthly);
}

// ── Status Components ──
const StatusDot: React.FC<{ status: string }> = ({ status }) => {
  const colors: Record<string, string> = { overdue: '#EF4444', due_soon: '#F59E0B', on_track: '#22C55E' };
  return <span className="inline-block w-2 h-2 rounded-full mr-2" style={{ background: colors[status] || '#999' }} />;
};

const StatusBadge: React.FC<{ status: string }> = ({ status }) => {
  const map: Record<string, { cls: string; label: string }> = {
    overdue: { cls: 'bg-red-100 text-red-700', label: '🔴 Overdue' },
    due_soon: { cls: 'bg-yellow-100 text-yellow-800', label: '🟡 Due Soon' },
    on_track: { cls: 'bg-green-100 text-green-800', label: '🟢 On Track' },
  };
  const s = map[status] || map.on_track;
  return <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold ${s.cls}`}>{s.label}</span>;
};

// ── Main Component ──
interface Props {
  onDataChanged?: () => Promise<void> | void;
}

const ContainerPlanner: React.FC<Props> = ({ onDataChanged }) => {
  const [items, setItems] = useState<Item[]>([]);
  const [lots, setLots] = useState<InventoryLot[]>([]);
  const [sales, setSales] = useState<SalesHistory[]>([]);
  const [transitContainers, setTransitContainers] = useState<TransitContainer[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingTransit, setSavingTransit] = useState(false);
  const [transitError, setTransitError] = useState<string | null>(null);
  const [manualItemId, setManualItemId] = useState('');
  const [manualQtyKg, setManualQtyKg] = useState('');
  const [manualLines, setManualLines] = useState<TransitContainerLine[]>([]);
  const [editingContainerId, setEditingContainerId] = useState<string | null>(null);
  const [editingLines, setEditingLines] = useState<TransitContainerLine[]>([]);
  const [editingItemId, setEditingItemId] = useState('');
  const [editingQtyKg, setEditingQtyKg] = useState('');
  const [shippingOpenByContainerId, setShippingOpenByContainerId] = useState<Record<string, boolean>>({});
  const [shippingDataByContainerId, setShippingDataByContainerId] = useState<Record<string, ShippingTrackerData>>({});
  const [shippingLoadingByContainerId, setShippingLoadingByContainerId] = useState<Record<string, boolean>>({});
  const [shippingErrorByContainerId, setShippingErrorByContainerId] = useState<Record<string, string | null>>({});
  const [shippingDraftByContainerId, setShippingDraftByContainerId] = useState<Record<string, {
    containerNumber: string;
    vesselIMO: string;
    destinationPort: string;
  }>>({});
  const [savingShippingContainerId, setSavingShippingContainerId] = useState<string | null>(null);
  const [meta, setMeta] = useState<{ orderNumber: string; shipName: string; eta: string; status: TransitContainerStatus }>({
    orderNumber: '',
    shipName: '',
    eta: '',
    status: 'on_po',
  });

  useEffect(() => {
    const loadData = async () => {
      try {
        const [dbItems, dbLots, dbSales, dbTransit] = await Promise.all([
          db.getAll<Item>('items'),
          db.getAll<InventoryLot>('lots'),
          db.getAll<SalesHistory>('sales'),
          db.getAll<TransitContainer>('transit_containers'),
        ]);
        setItems(dbItems);
        setLots(dbLots);
        setSales(dbSales);
        setTransitContainers(dbTransit);
      } catch (err) {
        console.error('Failed to load container planner data.', err);
      } finally {
        setLoading(false);
      }
    };
    loadData();
  }, []);

  const inTransitByItem = useMemo(() => {
    const totals: Record<string, number> = {};
    for (const container of transitContainers) {
      if (container.status === 'received') continue;
      for (const line of container.lines || []) {
        totals[line.itemId] = (totals[line.itemId] || 0) + Number(line.quantityKg || 0);
      }
    }
    return totals;
  }, [transitContainers]);

  const activeTransitContainers = useMemo(() => {
    return transitContainers
      .filter(c => c.status !== 'received')
      .sort((a, b) => new Date(a.eta).getTime() - new Date(b.eta).getTime());
  }, [transitContainers]);

  const baseProducts = useMemo(() => getProductBase(items, lots, sales, inTransitByItem), [items, lots, sales, inTransitByItem]);
  const [safetyPct, setSafetyPct] = useState(15);
  const [seasonals, setSeasonals] = useState<Record<string, number>>(() => {
    const m: Record<string, number> = {};
    baseProducts.forEach(p => { m[p.itemId] = 1.0; });
    return m;
  });
  const [overrides, setOverrides] = useState<Record<string, number>>({});

  useEffect(() => {
    setSeasonals(prev => {
      const next = { ...prev };
      for (const product of baseProducts) {
        if (next[product.itemId] === undefined) next[product.itemId] = 1.0;
      }
      return next;
    });
  }, [baseProducts]);

  const planRows: PlanRow[] = useMemo(() => {
    return baseProducts.map(p => {
      const seasonal = seasonals[p.itemId] ?? 1.0;
      const safetyMult = 1 + safetyPct / 100;
      const forecastWeekly = (p.avgMonthly / 4.33) * seasonal * safetyMult;
      const forecast8w = forecastWeekly * 8;
      const need = Math.max(0, forecast8w - p.effectiveStock);
      const pallets = Math.ceil(need / KG_PER_PALLET);
      const overridePallets = overrides[p.itemId] !== undefined ? overrides[p.itemId] : pallets;
      const overrideKg = overridePallets * KG_PER_PALLET;
      const totalAfterOrder = p.effectiveStock + overrideKg;
      const weeksOfStock = p.dailyDemand > 0 ? totalAfterOrder / (p.dailyDemand * 7) : 999;
      const shelfWeeks = p.shelfLife / 7;
      return {
        ...p,
        seasonal, forecast8w, need,
        suggestedPallets: pallets,
        pallets: overridePallets,
        kg: overrideKg,
        shelfAlert: weeksOfStock > shelfWeeks && overridePallets > 0,
        isOverride: overrides[p.itemId] !== undefined,
      };
    });
  }, [baseProducts, safetyPct, seasonals, overrides]);

  const totalPallets = planRows.reduce((a, b) => a + b.pallets, 0);
  const remaining = PALLETS_PER_CONTAINER - totalPallets;
  const shelfAlerts = planRows.filter(r => r.shelfAlert);

  if (loading) {
    return <div className="text-slate-500">Loading Container Planner...</div>;
  }

  if (baseProducts.length === 0) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-3xl font-bold text-slate-800 mb-2">Container Planner</h2>
          <p className="text-slate-500">No inventory and sales data available.</p>
        </div>
        <div className="bg-white rounded-2xl border border-slate-200 p-8 text-slate-500">
          Blank slate active. Import stock and sales data to build a container plan.
        </div>
      </div>
    );
  }

  const updateSeasonal = (itemId: string, val: string) => {
    setSeasonals(prev => ({ ...prev, [itemId]: parseFloat(val) || 1 }));
  };
  const updateOverride = (itemId: string, val: string) => {
    const num = parseInt(val);
    if (val === '' || isNaN(num)) {
      setOverrides(prev => { const n = { ...prev }; delete n[itemId]; return n; });
    } else {
      setOverrides(prev => ({ ...prev, [itemId]: Math.max(0, num) }));
    }
  };

  const refreshTransitContainers = async () => {
    const fresh = await db.getAll<TransitContainer>('transit_containers');
    setTransitContainers(fresh);
  };

  const refreshLots = async () => {
    const freshLots = await db.getAll<InventoryLot>('lots');
    setLots(freshLots);
  };

  const syncAppData = async () => {
    if (onDataChanged) {
      await onDataChanged();
    }
  };

  const ensureShippingDraft = (container: TransitContainer) => {
    setShippingDraftByContainerId(prev => {
      if (prev[container.id]) return prev;
      return {
        ...prev,
        [container.id]: {
          containerNumber: container.containerNumber || '',
          vesselIMO: container.vesselIMO || '',
          destinationPort: container.destinationPort || '',
        },
      };
    });
  };

  const loadShippingData = async (container: TransitContainer, forceRefresh = false) => {
    if (!container.vesselIMO && !container.containerNumber) return;

    setShippingLoadingByContainerId(prev => ({ ...prev, [container.id]: true }));
    setShippingErrorByContainerId(prev => ({ ...prev, [container.id]: null }));

    try {
      const data = await fetchShippingForContainer(container, { forceRefresh });
      if (data) {
        setShippingDataByContainerId(prev => ({ ...prev, [container.id]: data }));
      }
    } catch (err: any) {
      setShippingErrorByContainerId(prev => ({
        ...prev,
        [container.id]: err?.message || 'Unable to fetch shipping data',
      }));
    } finally {
      setShippingLoadingByContainerId(prev => ({ ...prev, [container.id]: false }));
    }
  };

  const saveShippingIdentifiers = async (container: TransitContainer) => {
    const draft = shippingDraftByContainerId[container.id] || {
      containerNumber: container.containerNumber || '',
      vesselIMO: container.vesselIMO || '',
      destinationPort: container.destinationPort || '',
    };

    const updatedContainer: TransitContainer = {
      ...container,
      containerNumber: draft.containerNumber.trim() || undefined,
      vesselIMO: draft.vesselIMO.trim() || undefined,
      destinationPort: draft.destinationPort.trim() || undefined,
      updatedAt: new Date().toISOString(),
    };

    setSavingShippingContainerId(container.id);
    try {
      await db.put('transit_containers', updatedContainer);
      await refreshTransitContainers();
      await syncAppData();
      setShippingErrorByContainerId(prev => ({ ...prev, [container.id]: null }));
      await loadShippingData(updatedContainer, true);
    } catch (err) {
      console.error('Failed to save shipping identifiers.', err);
      setShippingErrorByContainerId(prev => ({
        ...prev,
        [container.id]: 'Unable to save shipping identifiers',
      }));
    } finally {
      setSavingShippingContainerId(null);
    }
  };

  const toggleShippingTracker = (container: TransitContainer) => {
    const isOpen = Boolean(shippingOpenByContainerId[container.id]);
    ensureShippingDraft(container);
    setShippingOpenByContainerId(prev => ({ ...prev, [container.id]: !isOpen }));
    if (!isOpen && (container.vesselIMO || container.containerNumber)) {
      void loadShippingData(container, false);
    }
  };

  const validateTransitMeta = (): boolean => {
    if (!meta.orderNumber.trim() || !meta.shipName.trim() || !meta.eta) {
      setTransitError('Order number, ship name, and ETA are required.');
      return false;
    }
    setTransitError(null);
    return true;
  };

  const saveTransitContainer = async (source: 'manual' | 'builder', lines: TransitContainerLine[]) => {
    if (!validateTransitMeta()) return;

    setSavingTransit(true);
    try {
      const now = new Date().toISOString();
      const container: TransitContainer = {
        id: typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `tc_${Date.now()}`,
        orderNumber: meta.orderNumber.trim(),
        shipName: meta.shipName.trim(),
        eta: meta.eta,
        status: meta.status,
        source,
        lines,
        createdAt: now,
        updatedAt: now,
      };
      await db.put('transit_containers', container);
      await refreshTransitContainers();
      await syncAppData();
      setTransitError(null);
      setMeta(prev => ({ ...prev, orderNumber: '', shipName: '', eta: '' }));
    } catch (err) {
      console.error('Failed to save transit container.', err);
      setTransitError('Failed to save container entry.');
    } finally {
      setSavingTransit(false);
    }
  };

  const addManualContainer = async () => {
    if (manualLines.length === 0) {
      setTransitError('Add at least one stock line for a manual container.');
      return;
    }
    await saveTransitContainer('manual', manualLines);
    setManualLines([]);
  };

  const addBuilderContainer = async () => {
    const lines: TransitContainerLine[] = planRows
      .filter(row => row.pallets > 0)
      .map(row => ({
        itemId: row.itemId,
        itemName: row.name,
        pallets: row.pallets,
        quantityKg: row.pallets * KG_PER_PALLET,
      }));

    if (lines.length === 0) {
      setTransitError('No pallets in the current builder plan to finalize.');
      return;
    }

    await saveTransitContainer('builder', lines);
  };

  const updateContainerStatus = async (container: TransitContainer, status: TransitContainerStatus) => {
    try {
      if (status === 'received' && container.status !== 'received') {
        const dbLots = await db.getAll<InventoryLot>('lots');
        const today = new Date().toISOString().split('T')[0];

        for (const line of container.lines || []) {
          const receivedQty = Math.max(0, Number(line.quantityKg || 0));
          if (receivedQty <= 0) continue;

          const existingLot = dbLots
            .filter(l => l.itemId === line.itemId && l.status === 'available')
            .sort((a, b) => {
              const aDate = new Date(a.receivedDate || 0).getTime();
              const bDate = new Date(b.receivedDate || 0).getTime();
              return bDate - aDate;
            })[0];

          if (existingLot) {
            const updatedLot: InventoryLot = {
              ...existingLot,
              quantityRemaining: Number(existingLot.quantityRemaining || 0) + receivedQty,
              quantityReceived: Number(existingLot.quantityReceived || existingLot.quantityRemaining || 0) + receivedQty,
              notes: existingLot.notes
                ? `${existingLot.notes} | Received from container ${container.orderNumber}`
                : `Received from container ${container.orderNumber}`,
            };
            await db.put('lots', updatedLot);
          } else {
            const newLot: InventoryLot = {
              id: typeof crypto !== 'undefined' && 'randomUUID' in crypto
                ? crypto.randomUUID()
                : `lot_${Date.now()}_${line.itemId}`,
              itemId: line.itemId,
              lotNumber: `RCV-${today}-${container.orderNumber}`,
              expiryDate: null,
              quantityRemaining: receivedQty,
              quantityReceived: receivedQty,
              receivedDate: today,
              status: 'available',
              notes: `Auto-created from received container ${container.orderNumber} (${container.shipName})`,
            };
            await db.put('lots', newLot);
          }
        }
      }

      await db.put('transit_containers', {
        ...container,
        status,
        updatedAt: new Date().toISOString(),
      });

      await refreshTransitContainers();
      await refreshLots();
      await syncAppData();
    } catch (err) {
      console.error('Failed to update transit container status.', err);
      setTransitError('Failed to update container status.');
    }
  };

  const addManualLine = () => {
    if (!manualItemId) {
      setTransitError('Select a stock item first.');
      return;
    }
    const qty = Number(manualQtyKg);
    if (!Number.isFinite(qty) || qty <= 0) {
      setTransitError('Quantity must be greater than zero.');
      return;
    }

    const item = items.find(i => i.id === manualItemId);
    if (!item) {
      setTransitError('Selected item was not found.');
      return;
    }

    const pallets = Math.max(1, Math.ceil(qty / KG_PER_PALLET));

    setManualLines(prev => {
      const existingIdx = prev.findIndex(line => line.itemId === manualItemId);
      if (existingIdx === -1) {
        return [...prev, { itemId: item.id, itemName: item.name, quantityKg: qty, pallets }];
      }
      const next = [...prev];
      const mergedQty = next[existingIdx].quantityKg + qty;
      next[existingIdx] = {
        ...next[existingIdx],
        quantityKg: mergedQty,
        pallets: Math.max(1, Math.ceil(mergedQty / KG_PER_PALLET)),
      };
      return next;
    });

    setTransitError(null);
    setManualQtyKg('');
  };

  const removeManualLine = (itemId: string) => {
    setManualLines(prev => prev.filter(line => line.itemId !== itemId));
  };

  const deleteContainer = async (containerId: string) => {
    const ok = window.confirm('Delete this container from PO/In Transit?');
    if (!ok) return;
    try {
      await db.delete('transit_containers', containerId);
      await refreshTransitContainers();
      await syncAppData();
      setTransitError(null);
    } catch (err) {
      console.error('Failed to delete transit container.', err);
      setTransitError('Failed to delete container.');
    }
  };

  const startEditingContainer = (container: TransitContainer) => {
    setEditingContainerId(container.id);
    setEditingLines([...(container.lines || [])]);
    setEditingItemId('');
    setEditingQtyKg('');
    setTransitError(null);
    ensureShippingDraft(container);
    setShippingOpenByContainerId(prev => ({ ...prev, [container.id]: true }));
    if (container.vesselIMO || container.containerNumber) {
      void loadShippingData(container, false);
    }
  };

  const cancelEditingContainer = () => {
    setEditingContainerId(null);
    setEditingLines([]);
    setEditingItemId('');
    setEditingQtyKg('');
  };

  const addEditingLine = () => {
    if (!editingItemId) {
      setTransitError('Select a stock item first.');
      return;
    }
    const qty = Number(editingQtyKg);
    if (!Number.isFinite(qty) || qty <= 0) {
      setTransitError('Quantity must be greater than zero.');
      return;
    }
    const item = items.find(i => i.id === editingItemId);
    if (!item) {
      setTransitError('Selected item was not found.');
      return;
    }

    setEditingLines(prev => {
      const index = prev.findIndex(line => line.itemId === editingItemId);
      if (index === -1) {
        return [...prev, {
          itemId: item.id,
          itemName: item.name,
          quantityKg: qty,
          pallets: Math.max(1, Math.ceil(qty / KG_PER_PALLET)),
        }];
      }
      const next = [...prev];
      const mergedQty = next[index].quantityKg + qty;
      next[index] = {
        ...next[index],
        quantityKg: mergedQty,
        pallets: Math.max(1, Math.ceil(mergedQty / KG_PER_PALLET)),
      };
      return next;
    });

    setEditingQtyKg('');
    setTransitError(null);
  };

  const removeEditingLine = (itemId: string) => {
    setEditingLines(prev => prev.filter(line => line.itemId !== itemId));
  };

  const saveEditedContainer = async (container: TransitContainer) => {
    if (editingLines.length === 0) {
      setTransitError('Container must have at least one stock line.');
      return;
    }
    try {
      await db.put('transit_containers', {
        ...container,
        lines: editingLines,
        updatedAt: new Date().toISOString(),
      });
      await refreshTransitContainers();
      await syncAppData();
      cancelEditingContainer();
      setTransitError(null);
    } catch (err) {
      console.error('Failed to save container lines.', err);
      setTransitError('Failed to save container edits.');
    }
  };

  // Build pallet fill data
  const palletFill: { color: string; label: string; filled: boolean }[] = [];
  for (let i = 0; i < PALLETS_PER_CONTAINER; i++) {
    let count = 0; let found = false;
    for (const r of planRows) {
      if (i >= count && i < count + r.pallets) {
        const catColors: Record<string, string> = { Browser: 'bg-green-600', Clex: 'bg-blue-600', Segawean: 'bg-purple-600' };
        palletFill.push({ color: catColors[r.category] || 'bg-slate-500', label: r.name.replace('Browser ', '').replace('Clex ', '').replace('Segawean ', ''), filled: true });
        found = true; break;
      }
      count += r.pallets;
    }
    if (!found) palletFill.push({ color: '', label: '', filled: false });
  }

  return (
    <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
      <div className="space-y-6 xl:col-span-2">
      {/* Header */}
      <div>
        <h2 className="text-3xl font-bold text-slate-800 mb-2">Container Planner</h2>
        <p className="text-slate-500">
          8-week demand forecast · {PALLETS_PER_CONTAINER} pallets per container · {LEAD_TIME_WEEKS}-week lead time
        </p>
      </div>

      {/* Controls Row */}
      <div className="bg-white rounded-2xl p-5 border border-slate-200 shadow-sm flex flex-col md:flex-row items-start md:items-center gap-6">
        {/* Safety Stock Slider */}
        <div>
          <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider block mb-1">Safety Stock %</label>
          <div className="flex items-center gap-3">
            <input type="range" min="0" max="50" value={safetyPct} onChange={e => setSafetyPct(Number(e.target.value))}
              className="w-32 accent-green-600" />
            <span className="text-xl font-bold text-green-700 min-w-[3rem]">{safetyPct}%</span>
          </div>
        </div>

        {/* Container Gauge */}
        <div className="md:ml-auto flex gap-3">
          <div className={`px-5 py-3 rounded-xl text-white text-center ${totalPallets <= PALLETS_PER_CONTAINER ? 'bg-green-600' : 'bg-red-500'}`}>
            <div className="text-[10px] font-semibold uppercase opacity-80">Container</div>
            <div className="text-2xl font-bold">{totalPallets}/{PALLETS_PER_CONTAINER}</div>
            <div className="text-xs opacity-70">pallets</div>
          </div>
          {remaining > 0 && (
            <div className="px-5 py-3 rounded-xl bg-green-100 text-green-800 text-center">
              <div className="text-[10px] font-semibold uppercase">Remaining</div>
              <div className="text-2xl font-bold">{remaining}</div>
              <div className="text-xs">pallets</div>
            </div>
          )}
          {remaining < 0 && (
            <div className="px-5 py-3 rounded-xl bg-red-100 text-red-700 text-center">
              <div className="text-[10px] font-semibold uppercase">Over by</div>
              <div className="text-2xl font-bold">{Math.abs(remaining)}</div>
              <div className="text-xs">pallets</div>
            </div>
          )}
        </div>
      </div>

      {/* Shelf Life Alerts */}
      {shelfAlerts.length > 0 && (
        <div className="bg-orange-50 rounded-xl px-5 py-3 border border-orange-200">
          <p className="text-sm font-semibold text-orange-800 mb-1 flex items-center gap-1.5">
            <AlertTriangle size={14} /> Shelf Life Alerts — stock may expire before use:
          </p>
          <div className="flex gap-2 flex-wrap">
            {shelfAlerts.map(r => (
              <span key={r.name} className="text-xs px-2.5 py-1 rounded bg-orange-100 text-orange-800 font-medium">
                {r.name.replace('Browser ', '').replace('Clex ', '').replace('Segawean ', '')} ({r.shelfLifeMonths}mo)
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Planning Table */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="bg-slate-50 border-b-2 border-slate-200">
                {['Product', 'Stock', 'Avg/mo', 'Seasonal ×', '8wk Forecast', 'Need', 'Pallets', 'Shelf', 'Status'].map(h => (
                  <th key={h} className="px-4 py-3 font-semibold text-slate-500 text-[10px] uppercase tracking-wider">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {planRows.map(r => (
                <tr key={r.name} className={r.shelfAlert ? 'bg-yellow-50' : 'hover:bg-slate-50/50'}>
                  <td className="px-4 py-3 font-medium text-slate-700 whitespace-nowrap">
                    <StatusDot status={r.status} />
                    {r.name}
                  </td>
                  <td className="px-4 py-3 text-slate-500">
                    {fmtKg(r.stock)}
                    {r.inTransitStock > 0 && (
                      <div className="text-[10px] text-blue-600 font-semibold mt-1">+ {fmtKg(r.inTransitStock)} in transit</div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-500">{fmtKg(r.avgMonthly)}</td>
                  <td className="px-4 py-3">
                    <input type="number" step="0.1" min="0" max="3" value={r.seasonal}
                      onChange={e => updateSeasonal(r.itemId, e.target.value)}
                      className={`w-14 px-1.5 py-1 rounded border text-center text-xs font-medium focus:outline-none focus:ring-1 focus:ring-green-500
                        ${r.seasonal !== 1 ? 'bg-purple-50 border-purple-300 text-purple-700 font-semibold' : 'border-slate-200 text-slate-600'}
                      `}
                    />
                  </td>
                  <td className="px-4 py-3 font-medium text-slate-700">{fmtKg(r.forecast8w)}</td>
                  <td className={`px-4 py-3 font-semibold ${r.need > 0 ? 'text-red-600' : 'text-green-600'}`}>
                    {fmtKg(r.need)}
                  </td>
                  <td className="px-4 py-3">
                    <input type="number" min="0" max="20"
                      value={r.isOverride ? overrides[r.itemId] : r.suggestedPallets}
                      onChange={e => updateOverride(r.itemId, e.target.value)}
                      className={`w-12 px-1.5 py-1 rounded text-center text-sm font-bold focus:outline-none focus:ring-1 focus:ring-green-500
                        ${r.isOverride ? 'bg-purple-50 border-2 border-purple-400 text-purple-700' : 'border-2 border-green-500 text-green-700'}
                      `}
                    />
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-400">
                    {r.shelfLifeMonths}mo
                    {r.shelfAlert && <span className="ml-1 text-red-500">⚠️</span>}
                  </td>
                  <td className="px-4 py-3"><StatusBadge status={r.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Container Fill Visualization */}
      <div className="bg-white rounded-2xl p-5 border border-slate-200 shadow-sm">
        <h3 className="text-sm font-bold text-slate-800 mb-3">
          Container Fill — {totalPallets} of {PALLETS_PER_CONTAINER} pallets
        </h3>
        <div className="flex gap-1.5 flex-wrap">
          {palletFill.map((p, i) => (
            <div key={i} title={p.filled ? p.label : 'Empty'}
              className={`w-11 h-11 rounded-lg flex items-center justify-center text-[8px] font-semibold border
                ${p.filled ? `${p.color} text-white border-transparent` : 'bg-slate-100 text-slate-300 border-slate-200'}
              `}
            >
              {p.filled ? p.label.substring(0, 8) : i + 1}
            </div>
          ))}
        </div>
        <div className="flex gap-4 mt-3 text-xs text-slate-400">
          <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-green-600 inline-block" /> Browser</span>
          <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-blue-600 inline-block" /> Clex</span>
          <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-purple-600 inline-block" /> Segawean</span>
        </div>
      </div>

      <p className="text-xs text-slate-400 italic">
        All values are suggestions — you can override every pallet count and seasonal multiplier.
        Forecasts use 6-month avg + safety % + seasonal adjustment.
      </p>

      </div>

      <aside className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 space-y-5 h-fit">
        <div className="flex items-center gap-2">
          <Truck size={18} className="text-blue-600" />
          <h3 className="text-lg font-bold text-slate-800">PO / In Transit</h3>
        </div>

        <div className="text-xs text-slate-500 bg-slate-50 rounded-lg border border-slate-200 p-3">
          Add manual container entries or finalize the current builder output into this list. Active entries feed stock planning automatically.
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">Order Number</label>
            <input
              type="text"
              value={meta.orderNumber}
              onChange={e => setMeta(prev => ({ ...prev, orderNumber: e.target.value }))}
              className="w-full px-3 py-2 border rounded-lg text-sm"
              placeholder="PO-00123"
            />
          </div>
          <div>
            <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">Ship Name</label>
            <input
              type="text"
              value={meta.shipName}
              onChange={e => setMeta(prev => ({ ...prev, shipName: e.target.value }))}
              className="w-full px-3 py-2 border rounded-lg text-sm"
              placeholder="MV Horizon"
            />
          </div>
          <div>
            <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">ETA</label>
            <input
              type="date"
              value={meta.eta}
              onChange={e => setMeta(prev => ({ ...prev, eta: e.target.value }))}
              className="w-full px-3 py-2 border rounded-lg text-sm"
            />
          </div>
          <div>
            <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">Status</label>
            <select
              value={meta.status}
              onChange={e => setMeta(prev => ({ ...prev, status: e.target.value as TransitContainerStatus }))}
              className="w-full px-3 py-2 border rounded-lg text-sm"
            >
              <option value="on_po">On PO</option>
              <option value="on_the_way">On the Way</option>
            </select>
          </div>

          <div className="rounded-lg border border-slate-200 p-3 space-y-2">
            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Manual Cargo Lines</p>
            <div className="grid grid-cols-1 gap-2">
              <select
                value={manualItemId}
                onChange={e => setManualItemId(e.target.value)}
                className="w-full px-3 py-2 border rounded-lg text-sm"
              >
                <option value="">Select stock item</option>
                {items.map(item => (
                  <option key={item.id} value={item.id}>{item.name}</option>
                ))}
              </select>
              <div className="flex gap-2">
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={manualQtyKg}
                  onChange={e => setManualQtyKg(e.target.value)}
                  className="w-full px-3 py-2 border rounded-lg text-sm"
                  placeholder="Quantity (kg)"
                />
                <button
                  type="button"
                  onClick={addManualLine}
                  className="px-3 py-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700"
                  title="Add stock line"
                >
                  <Plus size={16} />
                </button>
              </div>
            </div>

            {manualLines.length > 0 && (
              <div className="max-h-28 overflow-y-auto text-xs border-t border-slate-100 pt-2 space-y-1">
                {manualLines.map(line => (
                  <div key={line.itemId} className="flex items-center justify-between gap-2 bg-slate-50 rounded px-2 py-1">
                    <span className="truncate text-slate-700">{line.itemName}</span>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-slate-600">{fmtKg(line.quantityKg)}</span>
                      <button
                        type="button"
                        onClick={() => removeManualLine(line.itemId)}
                        className="text-red-600 hover:text-red-700"
                        title="Remove line"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <button
              onClick={() => void addManualContainer()}
              disabled={savingTransit}
              className="px-3 py-2 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 disabled:opacity-60"
            >
              {savingTransit ? 'Saving...' : 'Add Manual'}
            </button>
            <button
              onClick={() => void addBuilderContainer()}
              disabled={savingTransit}
              className="px-3 py-2 rounded-lg bg-green-600 text-white text-sm font-semibold hover:bg-green-700 disabled:opacity-60"
            >
              Finalize Builder
            </button>
          </div>

          {transitError && (
            <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{transitError}</div>
          )}
        </div>

        <div className="border-t border-slate-200 pt-4 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-bold uppercase tracking-wider text-slate-500">Active Containers</p>
            <p className="text-xs text-slate-500">{activeTransitContainers.length}</p>
          </div>

          {activeTransitContainers.length === 0 && (
            <div className="text-sm text-slate-500 bg-slate-50 rounded-lg border border-slate-200 p-3">
              No containers currently on PO or on the way.
            </div>
          )}

          {activeTransitContainers.map(container => {
            const totalKg = (container.lines || []).reduce((sum, line) => sum + Number(line.quantityKg || 0), 0);
            const totalPallets = (container.lines || []).reduce((sum, line) => sum + Number(line.pallets || 0), 0);
            const statusLabel = container.status === 'on_po' ? 'On PO' : 'On the Way';
            const shippingDraft = shippingDraftByContainerId[container.id] || {
              containerNumber: container.containerNumber || '',
              vesselIMO: container.vesselIMO || '',
              destinationPort: container.destinationPort || '',
            };
            const shippingData = shippingDataByContainerId[container.id];
            const shippingStatus = shippingData?.shippingStatus || container.shippingStatus || 'Unknown';
            const shippingEta = shippingData?.etaIso || container.etaIso;
            const shippingDestination = shippingData?.destinationPort || shippingDraft.destinationPort || container.destinationPort;
            const shippingVesselName = shippingData?.vesselName || container.vesselName || container.shipName;
            const shippingLastUpdated = shippingData?.lastUpdatedIso || container.lastUpdatedIso;
            const shippingPosition = shippingData?.lastPosition || container.lastPosition;
            const shippingOpen = Boolean(shippingOpenByContainerId[container.id]);
            const shippingLoading = Boolean(shippingLoadingByContainerId[container.id]);
            const shippingError = shippingErrorByContainerId[container.id];
            const mapUrl = getMarineTrafficMapUrl({
              ...container,
              vesselIMO: shippingDraft.vesselIMO,
              containerNumber: shippingDraft.containerNumber,
            });
            return (
              <div key={container.id} className="rounded-lg border border-slate-200 p-3 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-sm font-bold text-slate-800">{container.orderNumber}</div>
                    <div className="text-xs text-slate-500">{container.shipName}</div>
                  </div>
                  <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold bg-blue-50 text-blue-700 border border-blue-200">
                    {statusLabel}
                  </span>
                </div>

                <div className="text-xs text-slate-600">
                  ETA: <span className="font-semibold">{new Date(container.eta).toLocaleDateString('en-ZA')}</span>
                </div>

                <div className="text-xs text-slate-600">
                  Cargo: {totalPallets} pallets · {fmtKg(totalKg)}
                  {container.source === 'builder' ? ' · from builder' : ' · manual entry'}
                </div>

                {(container.lines || []).length > 0 && (
                  <div className="max-h-24 overflow-y-auto text-[11px] text-slate-500 space-y-1 border-t border-slate-100 pt-2">
                    {container.lines.map((line, idx) => (
                      <div key={`${container.id}_${line.itemId}_${idx}`} className="flex justify-between gap-2">
                        <span className="truncate">{line.itemName}</span>
                        <span className="font-semibold">{line.pallets} pl</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Existing container detail panel integration: shipping tracker lives inside this side panel card. */}
                <button
                  type="button"
                  onClick={() => toggleShippingTracker(container)}
                  className="w-full px-2 py-1.5 border border-slate-200 bg-slate-50 text-slate-700 rounded-lg text-xs font-semibold hover:bg-slate-100 flex items-center justify-between"
                >
                  <span>Shipping Tracker</span>
                  {shippingOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                </button>

                {shippingOpen && (
                  <div className="rounded-lg border border-slate-200 p-2 space-y-2">
                    <div className="grid grid-cols-2 gap-2 text-[11px] text-slate-600">
                      <div>
                        <div className="text-slate-400">Container</div>
                        <div className="font-semibold text-slate-700">{shippingDraft.containerNumber || '—'}</div>
                      </div>
                      <div>
                        <div className="text-slate-400">Status</div>
                        <div className="font-semibold text-slate-700">{shippingStatus}</div>
                      </div>
                      <div className="col-span-2">
                        <div className="text-slate-400">Vessel</div>
                        <div className="font-semibold text-slate-700">
                          {shippingVesselName || '—'}
                          {shippingDraft.vesselIMO ? ` (${shippingDraft.vesselIMO})` : ''}
                        </div>
                      </div>
                      <div className="col-span-2">
                        <div className="text-slate-400">Destination</div>
                        <div className="font-semibold text-slate-700">{shippingDestination || '—'}</div>
                      </div>
                      <div>
                        <div className="text-slate-400">ETA</div>
                        <div className="font-semibold text-slate-700">{fmtIsoDateTime(shippingEta)}</div>
                      </div>
                      <div>
                        <div className="text-slate-400">Last Updated</div>
                        <div className="font-semibold text-slate-700">{fmtIsoDateTime(shippingLastUpdated)}</div>
                      </div>
                      {shippingPosition && (
                        <div className="col-span-2">
                          <div className="text-slate-400">Last Position</div>
                          <div className="font-semibold text-slate-700">
                            {shippingPosition.lat.toFixed(4)}, {shippingPosition.lon.toFixed(4)}
                          </div>
                        </div>
                      )}
                    </div>

                    <div className="grid grid-cols-1 gap-2 border-t border-slate-100 pt-2">
                      <input
                        type="text"
                        value={shippingDraft.containerNumber}
                        onChange={e => setShippingDraftByContainerId(prev => ({
                          ...prev,
                          [container.id]: {
                            ...shippingDraft,
                            containerNumber: e.target.value,
                          },
                        }))}
                        className="w-full px-2 py-1.5 border rounded-lg text-xs"
                        placeholder="Container number (e.g. MSKU1234567)"
                      />
                      <input
                        type="text"
                        value={shippingDraft.vesselIMO}
                        onChange={e => setShippingDraftByContainerId(prev => ({
                          ...prev,
                          [container.id]: {
                            ...shippingDraft,
                            vesselIMO: e.target.value,
                          },
                        }))}
                        className="w-full px-2 py-1.5 border rounded-lg text-xs"
                        placeholder="Vessel IMO"
                      />
                      <input
                        type="text"
                        value={shippingDraft.destinationPort}
                        onChange={e => setShippingDraftByContainerId(prev => ({
                          ...prev,
                          [container.id]: {
                            ...shippingDraft,
                            destinationPort: e.target.value,
                          },
                        }))}
                        className="w-full px-2 py-1.5 border rounded-lg text-xs"
                        placeholder="Destination port"
                      />
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                      <button
                        type="button"
                        onClick={() => void saveShippingIdentifiers(container)}
                        disabled={savingShippingContainerId === container.id}
                        className="px-2 py-1.5 rounded-lg bg-green-600 text-white text-xs font-semibold hover:bg-green-700 disabled:opacity-60"
                      >
                        {savingShippingContainerId === container.id ? 'Saving...' : 'Save'}
                      </button>
                      <button
                        type="button"
                        onClick={() => void loadShippingData({
                          ...container,
                          containerNumber: shippingDraft.containerNumber,
                          vesselIMO: shippingDraft.vesselIMO,
                          destinationPort: shippingDraft.destinationPort,
                        }, true)}
                        disabled={shippingLoading}
                        className="px-2 py-1.5 rounded-lg border border-slate-200 text-slate-700 text-xs font-semibold hover:bg-slate-50 flex items-center justify-center gap-1"
                      >
                        {shippingLoading ? (
                          <span className="w-3.5 h-3.5 border-2 border-slate-300 border-t-blue-600 rounded-full animate-spin" />
                        ) : (
                          <RefreshCw size={12} />
                        )}
                        Refresh
                      </button>
                      <a
                        href={mapUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="px-2 py-1.5 rounded-lg border border-slate-200 text-slate-700 text-xs font-semibold hover:bg-slate-50 flex items-center justify-center gap-1"
                      >
                        <ExternalLink size={12} /> View on map
                      </a>
                    </div>

                    {shippingError && (
                      <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-2 py-1.5">
                        {shippingError}
                      </div>
                    )}
                  </div>
                )}

                {editingContainerId !== container.id && (
                  <button
                    type="button"
                    onClick={() => startEditingContainer(container)}
                    className="w-full px-2 py-1.5 border border-slate-200 bg-slate-50 text-slate-700 rounded-lg text-xs font-semibold hover:bg-slate-100 flex items-center justify-center gap-1"
                  >
                    <Pencil size={12} /> Edit Lines
                  </button>
                )}

                {editingContainerId === container.id && (
                  <div className="rounded-lg border border-slate-200 p-2 space-y-2">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Edit Cargo Lines</p>
                    <div className="grid grid-cols-1 gap-2">
                      <select
                        value={editingItemId}
                        onChange={e => setEditingItemId(e.target.value)}
                        className="w-full px-2 py-1.5 border rounded-lg text-xs"
                      >
                        <option value="">Select stock item</option>
                        {items.map(item => (
                          <option key={item.id} value={item.id}>{item.name}</option>
                        ))}
                      </select>
                      <div className="flex gap-2">
                        <input
                          type="number"
                          min="0"
                          step="1"
                          value={editingQtyKg}
                          onChange={e => setEditingQtyKg(e.target.value)}
                          className="w-full px-2 py-1.5 border rounded-lg text-xs"
                          placeholder="Quantity (kg)"
                        />
                        <button
                          type="button"
                          onClick={addEditingLine}
                          className="px-2 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700"
                        >
                          <Plus size={12} />
                        </button>
                      </div>
                    </div>

                    <div className="max-h-24 overflow-y-auto text-[11px] space-y-1">
                      {editingLines.map(line => (
                        <div key={`edit_${container.id}_${line.itemId}`} className="flex items-center justify-between gap-2 bg-slate-50 rounded px-2 py-1">
                          <span className="truncate text-slate-700">{line.itemName}</span>
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-slate-600">{fmtKg(line.quantityKg)}</span>
                            <button
                              type="button"
                              onClick={() => removeEditingLine(line.itemId)}
                              className="text-red-600 hover:text-red-700"
                              title="Remove line"
                            >
                              <Trash2 size={12} />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => void saveEditedContainer(container)}
                        className="px-2 py-1.5 rounded-lg bg-green-600 text-white text-xs font-semibold hover:bg-green-700"
                      >
                        Save Changes
                      </button>
                      <button
                        type="button"
                        onClick={cancelEditingContainer}
                        className="px-2 py-1.5 rounded-lg border border-slate-200 text-slate-600 text-xs font-semibold hover:bg-slate-50"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                <select
                  value={container.status}
                  onChange={e => void updateContainerStatus(container, e.target.value as TransitContainerStatus)}
                  className="w-full px-2 py-1.5 border rounded-lg text-xs"
                >
                  <option value="on_po">On PO</option>
                  <option value="on_the_way">On the Way</option>
                  <option value="received">Received</option>
                </select>

                <button
                  type="button"
                  onClick={() => void deleteContainer(container.id)}
                  className="w-full px-2 py-1.5 border border-red-200 bg-red-50 text-red-700 rounded-lg text-xs font-semibold hover:bg-red-100"
                >
                  Delete Container
                </button>
              </div>
            );
          })}
        </div>
      </aside>
    </div>
  );
};

export default ContainerPlanner;
