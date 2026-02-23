import React, { useState, useMemo } from 'react';
import { Package, AlertTriangle, Info } from 'lucide-react';
import { RAW_SALES, CURRENT_STOCK, SHELF_LIVES, LEAD_TIME_WEEKS, KG_PER_PALLET, PALLETS_PER_CONTAINER } from '../salesData';

// ── Types ──
interface PlanRow {
  name: string;
  stock: number;
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
function getMonth(d: string): string { return d.substring(0, 7); }

function getProductBase() {
  const allNames = [...new Set(RAW_SALES.map(s => s.product))];
  const allMonths = [...new Set(RAW_SALES.map(s => getMonth(s.date)))].sort();
  const numMonths = allMonths.length || 1;
  const leadTimeDays = LEAD_TIME_WEEKS * 7;
  const reorderPointDays = leadTimeDays + 14;

  return allNames.map(name => {
    const totalSold = RAW_SALES.filter(s => s.product === name).reduce((a, b) => a + b.qty, 0);
    const avgMonthly = totalSold / numMonths;
    const dailyDemand = avgMonthly / 30.4;
    const stock = CURRENT_STOCK[name] || 0;
    const daysCover = dailyDemand > 0 ? Math.min(stock / dailyDemand, 999) : 999;
    const shelfLife = SHELF_LIVES[name] || 365;
    let status: 'overdue' | 'due_soon' | 'on_track' = 'on_track';
    if (daysCover < leadTimeDays) status = 'overdue';
    else if (daysCover < reorderPointDays) status = 'due_soon';
    return {
      name, stock, avgMonthly, dailyDemand, shelfLife,
      shelfLifeMonths: Math.round(shelfLife / 30), status,
      category: name.startsWith('Browser') ? 'Browser' : name.startsWith('Clex') ? 'Clex' : 'Segawean',
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
const ContainerPlanner: React.FC = () => {
  const baseProducts = useMemo(() => getProductBase(), []);
  const [safetyPct, setSafetyPct] = useState(15);
  const [seasonals, setSeasonals] = useState<Record<string, number>>(() => {
    const m: Record<string, number> = {};
    baseProducts.forEach(p => { m[p.name] = 1.0; });
    return m;
  });
  const [overrides, setOverrides] = useState<Record<string, number>>({});

  const planRows: PlanRow[] = useMemo(() => {
    return baseProducts.map(p => {
      const seasonal = seasonals[p.name] ?? 1.0;
      const safetyMult = 1 + safetyPct / 100;
      const forecastWeekly = (p.avgMonthly / 4.33) * seasonal * safetyMult;
      const forecast8w = forecastWeekly * 8;
      const need = Math.max(0, forecast8w - p.stock);
      const pallets = Math.ceil(need / KG_PER_PALLET);
      const overridePallets = overrides[p.name] !== undefined ? overrides[p.name] : pallets;
      const overrideKg = overridePallets * KG_PER_PALLET;
      const totalAfterOrder = p.stock + overrideKg;
      const weeksOfStock = p.dailyDemand > 0 ? totalAfterOrder / (p.dailyDemand * 7) : 999;
      const shelfWeeks = p.shelfLife / 7;
      return {
        ...p,
        seasonal, forecast8w, need,
        suggestedPallets: pallets,
        pallets: overridePallets,
        kg: overrideKg,
        shelfAlert: weeksOfStock > shelfWeeks && overridePallets > 0,
        isOverride: overrides[p.name] !== undefined,
      };
    });
  }, [baseProducts, safetyPct, seasonals, overrides]);

  const totalPallets = planRows.reduce((a, b) => a + b.pallets, 0);
  const remaining = PALLETS_PER_CONTAINER - totalPallets;
  const shelfAlerts = planRows.filter(r => r.shelfAlert);

  const updateSeasonal = (name: string, val: string) => {
    setSeasonals(prev => ({ ...prev, [name]: parseFloat(val) || 1 }));
  };
  const updateOverride = (name: string, val: string) => {
    const num = parseInt(val);
    if (val === '' || isNaN(num)) {
      setOverrides(prev => { const n = { ...prev }; delete n[name]; return n; });
    } else {
      setOverrides(prev => ({ ...prev, [name]: Math.max(0, num) }));
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
    <div className="space-y-6">
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
                  <td className="px-4 py-3 text-slate-500">{fmtKg(r.stock)}</td>
                  <td className="px-4 py-3 text-slate-500">{fmtKg(r.avgMonthly)}</td>
                  <td className="px-4 py-3">
                    <input type="number" step="0.1" min="0" max="3" value={r.seasonal}
                      onChange={e => updateSeasonal(r.name, e.target.value)}
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
                      value={r.isOverride ? overrides[r.name] : r.suggestedPallets}
                      onChange={e => updateOverride(r.name, e.target.value)}
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
  );
};

export default ContainerPlanner;
