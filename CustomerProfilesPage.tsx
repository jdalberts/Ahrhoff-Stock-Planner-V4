import React, { useState, useMemo, useEffect } from 'react';
import { ArrowLeft, Search, Users } from 'lucide-react';
import { SalesTransaction } from './types';
import { db } from './db';

interface CustomerProfile {
  name: string;
  transactions: SalesTransaction[];
  products: Record<string, { qty: number; count: number; lastDate: string }>;
  totalQty: number;
  totalRevenue: number;
  firstOrder: string;
  lastOrder: string;
  orderCount: number;
  avgOrderQty: number;
  orderFrequency: string;
  daysSinceLastOrder: number;
  reorderStatus: 'overdue' | 'due_soon' | 'on_track';
}

function normalizeCustomerName(name: string): string {
  return name
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .replace(/\(\s*/g, '(')
    .replace(/\s*\)/g, ')')
    .replace(/\)\s*Ltd\b/gi, ') Ltd')
    .replace(/\bPty\)\s*Ltd\b/gi, 'Pty) Ltd')
    .trim();
}

function fmtKg(v: number): string {
  if (Math.abs(v) >= 1000) return (v / 1000).toFixed(1) + 't';
  return Math.round(v) + ' kg';
}
function fmtR(v: number): string {
  return 'R' + v.toLocaleString('en-ZA', { maximumFractionDigits: 0 });
}
function fmtDate(d: string): string {
  return new Date(d).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: '2-digit' });
}
function daysAgo(d: string): number {
  return Math.floor((Date.now() - new Date(d).getTime()) / 86400000);
}
function getMonth(d: string): string { return d.substring(0, 7); }

function buildCustomers(sourceTransactions: SalesTransaction[]): Record<string, CustomerProfile> {
  const customers: Record<string, CustomerProfile> = {};

  for (const s of sourceTransactions) {
    const customerName = normalizeCustomerName(s.customer);
    if (!customers[customerName]) {
      customers[customerName] = {
        name: customerName, transactions: [], products: {},
        totalQty: 0, totalRevenue: 0, firstOrder: '', lastOrder: '',
        orderCount: 0, avgOrderQty: 0, orderFrequency: '',
        daysSinceLastOrder: 0, reorderStatus: 'on_track',
      };
    }
    const c = customers[customerName];
    c.transactions.push(s);
    c.totalQty += s.qty;
    c.totalRevenue += s.qty * s.pricePerKg;
    if (!c.products[s.product]) c.products[s.product] = { qty: 0, count: 0, lastDate: '' };
    c.products[s.product].qty += s.qty;
    c.products[s.product].count += 1;
    if (s.date > c.products[s.product].lastDate) c.products[s.product].lastDate = s.date;
  }

  for (const c of Object.values(customers)) {
    const dates = c.transactions.map(t => t.date).sort();
    c.firstOrder = dates[0];
    c.lastOrder = dates[dates.length - 1];
    c.orderCount = c.transactions.length;
    c.avgOrderQty = c.totalQty / c.orderCount;
    const uniqueMonths = [...new Set(c.transactions.map(t => getMonth(t.date)))];
    c.orderFrequency = uniqueMonths.length >= 2 ? (6 / uniqueMonths.length).toFixed(1) + ' mo' : '1 period';
    c.daysSinceLastOrder = daysAgo(c.lastOrder);
    c.reorderStatus = c.daysSinceLastOrder > 60 ? 'overdue' : c.daysSinceLastOrder > 30 ? 'due_soon' : 'on_track';
  }

  return customers;
}

const StatusBadge: React.FC<{ status: string }> = ({ status }) => {
  const map: Record<string, { cls: string; label: string }> = {
    overdue: { cls: 'bg-red-100 text-red-700', label: '🔴 Overdue' },
    due_soon: { cls: 'bg-yellow-100 text-yellow-800', label: '🟡 Due Soon' },
    on_track: { cls: 'bg-green-100 text-green-800', label: '🟢 Active' },
  };
  const s = map[status] || map.on_track;
  return <span className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold ${s.cls}`}>{s.label}</span>;
};

const CustomerProfiles: React.FC = () => {
  const [transactions, setTransactions] = useState<SalesTransaction[]>([]);
  const [dataSource, setDataSource] = useState<'empty' | 'imported'>('empty');
  const [isClearing, setIsClearing] = useState(false);
  const [importedCount, setImportedCount] = useState(0);

  useEffect(() => {
    const loadTransactions = async () => {
      try {
        const imported = await db.getAll<SalesTransaction>('salesTransactions');
        setImportedCount(imported.length);
        if (imported.length > 0) {
          setTransactions(imported);
          setDataSource('imported');
        } else {
          setTransactions([]);
          setDataSource('empty');
        }
      } catch (err) {
        console.error('Failed to load imported sales transactions, falling back to seed data.', err);
        setTransactions([]);
        setImportedCount(0);
        setDataSource('empty');
      }
    };

    loadTransactions();
  }, []);

  const allCustomers = useMemo(() => buildCustomers(transactions), [transactions]);
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const clearImportedCustomerData = async () => {
    if (importedCount === 0) {
      window.alert('No imported customer data to clear.');
      return;
    }
    const ok = window.confirm('Clear all imported customer transactions and switch back to fallback data?');
    if (!ok) return;

    setIsClearing(true);
    try {
      await db.clear('salesTransactions');
      setTransactions([]);
      setImportedCount(0);
      setDataSource('empty');
      setSelected(null);
      window.alert('Imported customer data cleared.');
    } catch (err) {
      console.error('Failed to clear imported customer transactions.', err);
      window.alert('Failed to clear imported customer data. Please try again.');
    } finally {
      setIsClearing(false);
    }
  };

  const customerList = Object.values(allCustomers)
    .filter(c => c.name.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => b.totalQty - a.totalQty);

  if (selected && allCustomers[selected]) {
    const c = allCustomers[selected];
    const prodEntries = Object.entries(c.products).sort((a, b) => b[1].qty - a[1].qty);

    return (
      <div className="space-y-6">
        <button onClick={() => setSelected(null)} className="flex items-center gap-1.5 text-green-700 font-semibold text-sm hover:underline">
          <ArrowLeft size={16} /> Back to All Customers
        </button>

        <div className="bg-white rounded-2xl p-6 border border-slate-200 shadow-sm">
          <div className="flex flex-col sm:flex-row justify-between items-start gap-3">
            <div>
              <h2 className="text-2xl font-bold text-slate-800">{c.name}</h2>
              <p className="text-sm text-slate-500 mt-1">
                Customer since {fmtDate(c.firstOrder)} · Last order {fmtDate(c.lastOrder)} ({c.daysSinceLastOrder}d ago)
              </p>
            </div>
            <StatusBadge status={c.reorderStatus} />
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4 mt-6">
            {[
              { label: 'Total Volume', value: fmtKg(c.totalQty) },
              { label: 'Total Revenue', value: fmtR(c.totalRevenue) },
              { label: 'Orders', value: c.orderCount },
              { label: 'Avg Order', value: fmtKg(c.avgOrderQty) },
              { label: 'Frequency', value: c.orderFrequency },
            ].map((kpi, i) => (
              <div key={i} className="bg-slate-50 rounded-xl p-3">
                <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">{kpi.label}</div>
                <div className="text-lg font-bold text-green-700 mt-1">{kpi.value}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-white rounded-2xl p-6 border border-slate-200 shadow-sm">
          <h3 className="text-lg font-bold text-slate-800 mb-4">Products Purchased</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b-2 border-slate-200">
                  {['Product', 'Total Qty', 'Orders', 'Last Order', 'Avg/Order'].map(h => (
                    <th key={h} className="px-4 py-2 font-semibold text-slate-500 text-xs uppercase tracking-wider">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {prodEntries.map(([pname, pd]) => (
                  <tr key={pname} className="hover:bg-slate-50/50">
                    <td className="px-4 py-3 font-medium text-slate-700">{pname}</td>
                    <td className="px-4 py-3 text-slate-600">{fmtKg(pd.qty)}</td>
                    <td className="px-4 py-3 text-slate-500">{pd.count}</td>
                    <td className="px-4 py-3 text-slate-500">{fmtDate(pd.lastDate)}</td>
                    <td className="px-4 py-3 text-slate-500">{fmtKg(pd.qty / pd.count)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="bg-white rounded-2xl p-6 border border-slate-200 shadow-sm">
          <h3 className="text-lg font-bold text-slate-800 mb-4">Full Buying History</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b-2 border-slate-200">
                  {['Date', 'Product', 'Qty (kg)', 'Price/kg', 'Total'].map(h => (
                    <th key={h} className="px-4 py-2 font-semibold text-slate-500 text-xs uppercase tracking-wider">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {c.transactions.sort((a, b) => b.date.localeCompare(a.date)).map((t, i) => (
                  <tr key={i} className={t.qty < 0 ? 'bg-red-50' : 'hover:bg-slate-50/50'}>
                    <td className="px-4 py-3 text-slate-500">{fmtDate(t.date)}</td>
                    <td className="px-4 py-3 font-medium text-slate-700">{t.product}</td>
                    <td className={`px-4 py-3 ${t.qty < 0 ? 'text-red-600 font-semibold' : 'text-slate-600'}`}>
                      {t.qty.toLocaleString('en-ZA')}
                    </td>
                    <td className="px-4 py-3 text-slate-500">{fmtR(t.pricePerKg)}</td>
                    <td className={`px-4 py-3 font-semibold ${t.qty < 0 ? 'text-red-600' : 'text-green-700'}`}>
                      {fmtR(t.qty * t.pricePerKg)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <h2 className="text-3xl font-bold text-slate-800">Customer Profiles</h2>
            <span className={`px-2 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider border ${
              dataSource === 'imported'
                ? 'bg-green-50 text-green-700 border-green-200'
                : 'bg-amber-50 text-amber-700 border-amber-200'
            }`}>
              {dataSource === 'imported' ? 'Data Source: Imported' : 'Data Source: Empty'}
            </span>
          </div>
          <p className="text-slate-500">{customerList.length} customers · Sorted by total volume</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={clearImportedCustomerData}
            disabled={isClearing}
            className="px-3 py-2 text-amber-700 bg-amber-50 border border-amber-200 rounded-lg font-medium text-xs hover:bg-amber-100 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isClearing ? 'Clearing...' : `Clear Imported (${importedCount})`}
          </button>
          <div className="relative">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text" placeholder="Search customers..."
            value={search} onChange={e => setSearch(e.target.value)}
            className="pl-9 pr-4 py-2 rounded-lg border border-slate-200 text-sm w-60 focus:outline-none focus:ring-2 focus:ring-green-500/30 focus:border-green-500"
          />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {customerList.map(c => {
          const topProducts = Object.entries(c.products).sort((a, b) => b[1].qty - a[1].qty).slice(0, 3);
          return (
            <div
              key={c.name}
              onClick={() => setSelected(c.name)}
              className="bg-white rounded-2xl p-5 border border-slate-200 shadow-sm cursor-pointer hover:shadow-md hover:border-green-300 transition-all"
            >
              <div className="flex justify-between items-start mb-3">
                <div>
                  <h4 className="font-bold text-slate-800">{c.name}</h4>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Last: {fmtDate(c.lastOrder)} · {c.orderCount} orders
                  </p>
                </div>
                <StatusBadge status={c.reorderStatus} />
              </div>

              <div className="flex gap-6 mb-3">
                {[
                  { label: 'Volume', value: fmtKg(c.totalQty) },
                  { label: 'Revenue', value: fmtR(c.totalRevenue) },
                  { label: 'Freq', value: c.orderFrequency },
                ].map((m, i) => (
                  <div key={i}>
                    <div className="text-[10px] font-semibold text-slate-400 uppercase">{m.label}</div>
                    <div className="text-base font-bold text-green-700">{m.value}</div>
                  </div>
                ))}
              </div>

              <div className="flex gap-1.5 flex-wrap">
                {topProducts.map(([pn]) => (
                  <span key={pn} className="text-[10px] px-2 py-0.5 rounded bg-slate-100 text-slate-500 font-medium">
                    {pn.replace('Browser ', '').replace('Clex ', '').replace('Segawean ', '')}
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {customerList.length === 0 && (
        <div className="text-center py-20 text-slate-400">
          <Users className="mx-auto mb-3 opacity-20" size={48} />
          <p className="font-medium">No customers match your search.</p>
        </div>
      )}
    </div>
  );
};

export default CustomerProfiles;
