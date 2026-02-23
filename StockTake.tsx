import React from 'react';
import { AlertTriangle, Package, Users, TrendingUp, ArrowRight } from 'lucide-react';
import { SalesTransaction } from '../types';
import { RAW_SALES, CURRENT_STOCK, SHELF_LIVES, LEAD_TIME_WEEKS, KG_PER_PALLET } from '../salesData';

// ── Types ──
interface ProductSummary {
  name: string;
  stock: number;
  shelfLife: number;
  shelfLifeMonths: number;
  totalSold: number;
  avgMonthly: number;
  dailyDemand: number;
  daysCover: number;
  status: 'overdue' | 'due_soon' | 'on_track';
  category: string;
}

// ── Helpers ──
function fmtKg(v: number): string {
  if (Math.abs(v) >= 1000) return (v / 1000).toFixed(1) + 't';
  return Math.round(v) + ' kg';
}

function getMonth(d: string): string { return d.substring(0, 7); }

function buildProducts(): ProductSummary[] {
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

    let status: ProductSummary['status'] = 'on_track';
    if (daysCover < leadTimeDays) status = 'overdue';
    else if (daysCover < reorderPointDays) status = 'due_soon';

    return {
      name, stock, shelfLife,
      shelfLifeMonths: Math.round(shelfLife / 30),
      totalSold, avgMonthly, dailyDemand, daysCover, status,
      category: name.startsWith('Browser') ? 'Browser' : name.startsWith('Clex') ? 'Clex' : 'Segawean',
    };
  }).sort((a, b) => a.daysCover - b.daysCover);
}

// ── Status Components ──
const StatusDot: React.FC<{ status: string; size?: number }> = ({ status, size = 10 }) => {
  const colors: Record<string, string> = { overdue: '#EF4444', due_soon: '#F59E0B', on_track: '#22C55E' };
  return <span className="inline-block rounded-full" style={{ width: size, height: size, background: colors[status] || '#999' }} />;
};

const StatusBadge: React.FC<{ status: string }> = ({ status }) => {
  const map: Record<string, { cls: string; label: string }> = {
    overdue: { cls: 'bg-red-100 text-red-700', label: '🔴 Overdue' },
    due_soon: { cls: 'bg-yellow-100 text-yellow-800', label: '🟡 Due Soon' },
    on_track: { cls: 'bg-green-100 text-green-800', label: '🟢 On Track' },
  };
  const s = map[status] || map.on_track;
  return <span className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold ${s.cls}`}>{s.label}</span>;
};

// ── Main Component ──
interface Props {
  setActiveTab: (tab: string) => void;
}

const ReorderRadar: React.FC<Props> = ({ setActiveTab }) => {
  const products = buildProducts();
  const overdue = products.filter(p => p.status === 'overdue');
  const dueSoon = products.filter(p => p.status === 'due_soon');
  const onTrack = products.filter(p => p.status === 'on_track');
  const lowStock = products.filter(p => p.daysCover < 90);
  const totalStock = products.reduce((a, b) => a + b.stock, 0);
  const totalMonthlyDemand = products.reduce((a, b) => a + b.avgMonthly, 0);
  const customerCount = new Set(RAW_SALES.map(s => s.customer)).size;
  const alertCount = overdue.length + dueSoon.length;

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h2 className="text-3xl font-bold text-slate-800 mb-2">Reorder Radar</h2>
        <p className="text-slate-500">
          Traffic-light stock overview — {new Date().toLocaleDateString('en-ZA', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
        </p>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        {[
          { title: 'Total Stock', value: fmtKg(totalStock), sub: `${products.length} products`, icon: Package, color: 'bg-green-600' },
          { title: 'Monthly Demand', value: fmtKg(totalMonthlyDemand), sub: 'avg across 6 months', icon: TrendingUp, color: 'bg-blue-600' },
          { title: 'Active Customers', value: customerCount, sub: '6-month period', icon: Users, color: 'bg-purple-600' },
          { title: 'Alerts', value: alertCount, sub: `${overdue.length} critical`, icon: AlertTriangle, color: alertCount > 0 ? 'bg-red-500' : 'bg-slate-400' },
        ].map((kpi, i) => (
          <div key={i} className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
            <div className="flex items-center justify-between mb-4">
              <div className={`p-3 rounded-xl ${kpi.color} text-white`}>
                <kpi.icon size={24} />
              </div>
            </div>
            <h3 className="text-slate-500 font-medium mb-1">{kpi.title}</h3>
            <p className="text-3xl font-bold text-slate-900">{kpi.value}</p>
            <p className="text-xs text-slate-400 mt-1">{kpi.sub}</p>
          </div>
        ))}
      </div>

      {/* Reorder Bar Chart */}
      <div className="bg-white rounded-2xl p-6 border border-slate-200 shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between mb-6 gap-3">
          <h3 className="text-xl font-bold text-slate-800">Stock Cover by Product</h3>
          <div className="flex gap-4 text-sm text-slate-500">
            <span className="flex items-center gap-1.5"><StatusDot status="overdue" size={8} /> {overdue.length} Overdue</span>
            <span className="flex items-center gap-1.5"><StatusDot status="due_soon" size={8} /> {dueSoon.length} Due Soon</span>
            <span className="flex items-center gap-1.5"><StatusDot status="on_track" size={8} /> {onTrack.length} On Track</span>
          </div>
        </div>

        <div className="space-y-1.5">
          {products.map(p => {
            const barPct = Math.min((p.daysCover / 365) * 100, 100);
            const barColor = p.status === 'overdue' ? 'bg-red-500' : p.status === 'due_soon' ? 'bg-yellow-400' : 'bg-green-500';
            const shortName = p.name.replace('Browser ', '').replace('Clex ', '').replace('Segawean ', '');
            return (
              <div key={p.name} className="flex items-center gap-3 py-2">
                <StatusDot status={p.status} />
                <span className="w-44 text-sm font-medium text-slate-700 truncate" title={p.name}>{shortName}</span>
                <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden">
                  <div className={`h-full ${barColor} rounded-full transition-all duration-700`} style={{ width: barPct + '%' }} />
                </div>
                <span className={`w-16 text-right text-sm font-semibold ${p.daysCover < 60 ? 'text-red-600' : 'text-slate-500'}`}>
                  {p.daysCover >= 999 ? '—' : Math.round(p.daysCover) + 'd'}
                </span>
                <span className="w-16 text-right text-xs text-slate-400">{fmtKg(p.stock)}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Low Stock Warnings */}
      {lowStock.length > 0 && (
        <div className="bg-orange-50 rounded-2xl p-6 border border-orange-200">
          <h3 className="text-lg font-bold text-orange-900 mb-4 flex items-center gap-2">
            <AlertTriangle size={20} className="text-orange-500" />
            Low Stock Warnings ({lowStock.length} products)
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {lowStock.map(p => (
              <div key={p.name} className="bg-white rounded-xl p-4 border border-orange-200">
                <div className="flex justify-between items-start">
                  <div>
                    <h4 className="font-bold text-slate-800 text-sm">{p.name}</h4>
                    <p className="text-xs text-slate-500 mt-1">
                      Stock: {fmtKg(p.stock)} · {Math.round(p.daysCover)}d cover · Shelf: {p.shelfLifeMonths}mo
                    </p>
                  </div>
                  <StatusBadge status={p.status} />
                </div>
                <p className="text-xs text-orange-700 font-medium mt-2">
                  Need ~{fmtKg(p.avgMonthly * 2)} for next 8 weeks · Have {fmtKg(p.stock)}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Next Container Summary */}
      <div className="bg-green-700 rounded-2xl p-6 text-white">
        <h3 className="text-lg font-bold mb-1">Next Container Order Summary</h3>
        <p className="text-sm text-green-200 mb-4">Based on 8-week forecast · 20 pallets max · Lead time {LEAD_TIME_WEEKS} weeks</p>
        <div className="flex gap-4 flex-wrap">
          {overdue.concat(dueSoon).slice(0, 6).map(p => {
            const need = Math.max(0, Math.ceil((p.avgMonthly * 2 - p.stock) / KG_PER_PALLET));
            return (
              <div key={p.name} className="bg-white/10 rounded-xl px-4 py-3 min-w-[140px]">
                <div className="text-xs font-semibold text-green-200">{p.name.replace('Browser ', '').replace('Clex ', '').replace('Segawean ', '')}</div>
                <div className="text-2xl font-bold mt-1">{need} pallet{need !== 1 ? 's' : ''}</div>
                <div className="text-xs text-green-300">{fmtKg(need * KG_PER_PALLET)}</div>
              </div>
            );
          })}
        </div>
        <button
          onClick={() => setActiveTab('container')}
          className="mt-4 flex items-center gap-2 px-5 py-2.5 bg-white text-green-700 font-bold rounded-xl hover:bg-green-50 transition-colors text-sm"
        >
          Open Container Planner <ArrowRight size={16} />
        </button>
      </div>
    </div>
  );
};

export default ReorderRadar;
