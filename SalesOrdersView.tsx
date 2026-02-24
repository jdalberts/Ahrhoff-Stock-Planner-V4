import React, { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Download, Search, Trash2, X } from 'lucide-react';
import { db } from './db';
import { CustomerV5, ImportBatchV5, OrderLineV5, OrderV5, SalesTransaction } from './types';
import { CANONICAL_PRODUCT_NAMES, isCreditDocument, normalizeProductName, parsePackInfo } from './productNormalization';

type ProductFilterValue = '' | 'OTHER' | string;

interface EnrichedOrderLine extends OrderLineV5 {
  productNameNormalizedResolved: string;
  normalizedMatched: boolean;
  memoResolved: string;
  uomResolved: string;
  signedAmount: number;
  signedQty: number;
}

interface EnrichedOrder extends OrderV5 {
  displayTotal: number;
  isCredit: boolean;
  lineCount: number;
  lines: EnrichedOrderLine[];
}

interface FallbackOrderGroup {
  order: EnrichedOrder;
  lines: EnrichedOrderLine[];
}

const csvEscape = (value: string | number): string => {
  const raw = String(value ?? '');
  if (/[,"\n]/.test(raw)) return `"${raw.replace(/"/g, '""')}"`;
  return raw;
};

const saveCsv = (fileName: string, headers: string[], rows: Array<Array<string | number>>) => {
  const csv = [headers.join(','), ...rows.map(row => row.map(csvEscape).join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
};

const money = (amount: number): string => `R${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const normalizeNameKey = (value: string): string => value.toLowerCase().replace(/\s+/g, ' ').trim();

const productFilterPass = (line: EnrichedOrderLine, selected: ProductFilterValue): boolean => {
  if (!selected) return true;
  if (selected === 'OTHER') return !line.normalizedMatched;
  return line.productNameNormalizedResolved === selected;
};

const SalesOrdersView: React.FC = () => {
  const [orders, setOrders] = useState<EnrichedOrder[]>([]);
  const [customers, setCustomers] = useState<CustomerV5[]>([]);
  const [batches, setBatches] = useState<ImportBatchV5[]>([]);
  const [customerFilter, setCustomerFilter] = useState('');
  const [productFilter, setProductFilter] = useState<ProductFilterValue>('');
  const [docTypeFilter, setDocTypeFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [expandedOrderIds, setExpandedOrderIds] = useState<Set<string>>(new Set());
  const [selectedCustomerName, setSelectedCustomerName] = useState('');
  const [selectedOrderId, setSelectedOrderId] = useState('');
  const [selectedOrderIds, setSelectedOrderIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const toggleExpanded = (orderId: string) => {
    setExpandedOrderIds(prev => {
      const next = new Set(prev);
      if (next.has(orderId)) next.delete(orderId);
      else next.add(orderId);
      return next;
    });
  };

  const toggleSelectedOrder = (orderId: string) => {
    setSelectedOrderIds(prev => {
      const next = new Set(prev);
      if (next.has(orderId)) next.delete(orderId);
      else next.add(orderId);
      return next;
    });
  };

  const setAllFilteredSelection = (rows: EnrichedOrder[], selected: boolean) => {
    setSelectedOrderIds(prev => {
      const next = new Set(prev);
      for (const row of rows) {
        if (selected) next.add(row.id);
        else next.delete(row.id);
      }
      return next;
    });
  };

  const buildOrdersFromFallbackTransactions = (transactions: SalesTransaction[]): FallbackOrderGroup[] => {
    const groups = new Map<string, SalesTransaction[]>();

    for (const tx of transactions) {
      const key = `${normalizeNameKey(tx.customer)}|${tx.date}|invoice|legacy`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(tx);
    }

    const output: FallbackOrderGroup[] = [];

    for (const [key, txRows] of groups.entries()) {
      const first = txRows[0];
      const orderId = `legacy-${key}`;
      const customerNameRaw = first.customer || 'Unknown Customer';
      const docDate = first.date || '';
      const lines: EnrichedOrderLine[] = txRows.map((tx, index) => {
        const productRaw = tx.product || 'Unknown Product';
        const normalized = normalizeProductName(productRaw);
        const amount = Number(tx.qty || 0) * Number(tx.pricePerKg || 0);
        return {
          id: `${orderId}-line-${index}`,
          orderId,
          productNameRaw: productRaw,
          productNameNormalized: normalized.canonical,
          memo: '',
          qty: Number(tx.qty || 0),
          unitPrice: Number(tx.pricePerKg || 0),
          amount,
          sortIndex: index,
          createdAt: new Date().toISOString(),
          productNameNormalizedResolved: normalized.canonical,
          normalizedMatched: normalized.matched,
          memoResolved: '',
          uomResolved: '',
          signedAmount: amount,
          signedQty: Number(tx.qty || 0),
        };
      });

      const total = lines.reduce((sum, line) => sum + line.amount, 0);
      const order: EnrichedOrder = {
        id: orderId,
        docNumber: '',
        docType: 'Invoice',
        docDate,
        customerId: normalizeNameKey(customerNameRaw),
        customerNameRaw,
        subtotal: total,
        total,
        status: 'legacy',
        importBatchId: '',
        hashKey: key,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        displayTotal: total,
        isCredit: false,
        lineCount: lines.length,
        lines,
      };

      output.push({ order, lines });
    }

    return output.sort((a, b) => b.order.docDate.localeCompare(a.order.docDate));
  };

  const loadData = async () => {
    setLoading(true);
    setLoadError('');

    try {
      const [dbOrders, dbLines, dbCustomers, dbBatches, legacySalesTransactions] = await Promise.all([
        db.getAll<OrderV5>('orders'),
        db.getAll<OrderLineV5>('order_lines'),
        db.getAll<CustomerV5>('customers'),
        db.getAll<ImportBatchV5>('import_batches'),
        db.getAll<SalesTransaction>('salesTransactions'),
      ]);

      setCustomers(dbCustomers);
      setBatches(dbBatches.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));

      if (dbOrders.length === 0 && legacySalesTransactions.length > 0) {
        const fallback = buildOrdersFromFallbackTransactions(legacySalesTransactions);
        setOrders(fallback.map(row => row.order));
        return;
      }

      const lineMap = new Map<string, EnrichedOrderLine[]>();
      for (const line of dbLines) {
        const normalized = normalizeProductName(line.productNameNormalized || line.productNameRaw || '');
        const memoResolved = line.memo || '';
        const packInfo = parsePackInfo(memoResolved);
        const isCreditLine = false;

        const enrichedLine: EnrichedOrderLine = {
          ...line,
          productNameNormalizedResolved: line.productNameNormalized || normalized.canonical,
          normalizedMatched: Boolean(line.productNameNormalized) || normalized.matched,
          memoResolved,
          uomResolved: line.uom || line.packUom || packInfo.packUom || '',
          signedAmount: Number(line.amount || 0),
          signedQty: Number(line.qty || 0),
        };

        if (!lineMap.has(line.orderId)) lineMap.set(line.orderId, []);
        lineMap.get(line.orderId)!.push(enrichedLine);
      }

      const enrichedOrders: EnrichedOrder[] = dbOrders
        .map(order => {
          const lines = (lineMap.get(order.id) || []).sort((a, b) => a.sortIndex - b.sortIndex);
          const credit = isCreditDocument(order.docType || '');
          const signedLines = lines.map(line => ({
            ...line,
            signedAmount: credit ? -Math.abs(Number(line.amount || 0)) : Number(line.amount || 0),
            signedQty: credit ? -Math.abs(Number(line.qty || 0)) : Number(line.qty || 0),
          }));
          const lineTotal = signedLines.reduce((sum, line) => sum + line.signedAmount, 0);
          const baseTotal = Number(order.total || 0);
          const displayTotal = signedLines.length > 0 ? lineTotal : (credit ? -Math.abs(baseTotal) : baseTotal);

          return {
            ...order,
            lines: signedLines,
            lineCount: signedLines.length,
            isCredit: credit,
            displayTotal,
          };
        })
        .sort((a, b) => b.docDate.localeCompare(a.docDate));

      setOrders(enrichedOrders);
    } catch (error: any) {
      setLoadError(error?.message || 'Failed to load sales/orders data.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, []);

  const docTypes = useMemo(() => [...new Set(orders.map(order => order.docType).filter(Boolean))], [orders]);

  const filteredOrders = useMemo(() => {
    return orders.filter(order => {
      if (customerFilter && !order.customerNameRaw.toLowerCase().includes(customerFilter.toLowerCase())) return false;
      if (docTypeFilter && order.docType !== docTypeFilter) return false;
      if (dateFrom && order.docDate < dateFrom) return false;
      if (dateTo && order.docDate > dateTo) return false;
      if (productFilter) {
        if (!order.lines.some(line => productFilterPass(line, productFilter))) return false;
      }
      return true;
    });
  }, [orders, customerFilter, docTypeFilter, dateFrom, dateTo, productFilter]);

  const selectedCustomerOrders = useMemo(() => {
    if (!selectedCustomerName) return [];
    return filteredOrders.filter(order => normalizeNameKey(order.customerNameRaw) === normalizeNameKey(selectedCustomerName));
  }, [filteredOrders, selectedCustomerName]);

  const customerTotals = useMemo(() => {
    const revenue = selectedCustomerOrders.reduce((sum, order) => sum + order.displayTotal, 0);
    const orderCount = selectedCustomerOrders.length;
    return { revenue, orderCount };
  }, [selectedCustomerOrders]);

  const customerProductBreakdown = useMemo(() => {
    const grouped = new Map<string, { product: string; qty: number; amount: number }>();

    for (const order of selectedCustomerOrders) {
      for (const line of order.lines) {
        const product = line.productNameNormalizedResolved || line.productNameRaw || 'Unknown Product';
        const key = normalizeNameKey(product);
        if (!grouped.has(key)) {
          grouped.set(key, { product, qty: 0, amount: 0 });
        }
        const row = grouped.get(key)!;
        row.qty += Number(line.signedQty || 0);
        row.amount += Number(line.signedAmount || 0);
      }
    }

    const totalSpend = [...grouped.values()].reduce((sum, row) => sum + row.amount, 0);

    return [...grouped.values()]
      .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
      .map(row => ({
        ...row,
        share: totalSpend === 0 ? 0 : (row.amount / totalSpend) * 100,
      }));
  }, [selectedCustomerOrders]);

  const selectedOrderDetail = useMemo(() => {
    if (!selectedOrderId) return null;
    return orders.find(order => order.id === selectedOrderId) || null;
  }, [orders, selectedOrderId]);

  const exportSelectedFilteredOrdersCsv = () => {
    const rowsSource = filteredOrders.filter(order => selectedOrderIds.has(order.id));
    const source = rowsSource.length > 0 ? rowsSource : filteredOrders;

    const rows: Array<Array<string | number>> = [];
    for (const order of source) {
      for (const line of order.lines) {
        rows.push([
          order.docDate,
          order.customerNameRaw,
          order.docType,
          order.docNumber || '',
          line.productNameNormalizedResolved,
          line.productNameRaw,
          line.signedQty,
          line.uomResolved || '',
          line.memoResolved,
          line.signedAmount,
        ]);
      }
    }

    saveCsv('orders_filtered_product_breakdown.csv', [
      'Doc Date',
      'Customer',
      'Doc Type',
      'Doc Number',
      'Product Normalized',
      'Product Raw',
      'Qty',
      'Unit',
      'Memo/Pack',
      'Amount',
    ], rows);
  };

  const exportCustomerBreakdownCsv = () => {
    if (!selectedCustomerName) return;

    const rows = customerProductBreakdown.map(row => [
      selectedCustomerName,
      row.product,
      row.qty,
      row.amount,
      `${row.share.toFixed(2)}%`,
    ]);

    saveCsv('customer_product_breakdown.csv', ['Customer', 'Product', 'Total Qty', 'Total Amount', '% Share'], rows);
  };

  const deleteBatch = async (batchId: string) => {
    const ok = window.confirm('Delete this import batch and all related orders/lines?');
    if (!ok) return;

    const ordersToDelete = orders.filter(order => order.importBatchId === batchId);
    const orderIds = new Set(ordersToDelete.map(order => order.id));

    for (const order of ordersToDelete) {
      for (const line of order.lines) {
        if (orderIds.has(line.orderId)) await db.delete('order_lines', line.id);
      }
      await db.delete('orders', order.id);
    }

    await db.delete('import_batches', batchId);
    await loadData();
  };

  if (loading) {
    return (
      <div className="bg-white rounded-2xl border border-slate-200 p-8 text-slate-500">
        Loading Sales / Orders...
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-3xl font-bold text-slate-800 mb-2">Sales / Orders</h2>
        <p className="text-slate-500">Product-level customer and order analysis with normalized item breakdowns.</p>
      </div>

      {loadError && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-3 text-sm">
          {loadError}
        </div>
      )}

      <div className="bg-white rounded-2xl border border-slate-200 p-4 space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-3 text-slate-400" />
            <input
              value={customerFilter}
              onChange={e => setCustomerFilter(e.target.value)}
              placeholder="Customer search"
              className="w-full pl-9 pr-3 py-2 border rounded-lg"
            />
          </div>
          <select value={productFilter} onChange={e => setProductFilter(e.target.value)} className="px-3 py-2 border rounded-lg">
            <option value="">All Products</option>
            {CANONICAL_PRODUCT_NAMES.map(name => (
              <option key={name} value={name}>{name}</option>
            ))}
            <option value="OTHER">Other (Unmatched)</option>
          </select>
          <select value={docTypeFilter} onChange={e => setDocTypeFilter(e.target.value)} className="px-3 py-2 border rounded-lg">
            <option value="">All Doc Types</option>
            {docTypes.map(type => <option key={type} value={type}>{type}</option>)}
          </select>
          <input value={dateFrom} onChange={e => setDateFrom(e.target.value)} type="date" className="px-3 py-2 border rounded-lg" />
          <input value={dateTo} onChange={e => setDateTo(e.target.value)} type="date" className="px-3 py-2 border rounded-lg" />
        </div>

        <div className="flex flex-wrap gap-2">
          <button onClick={() => exportSelectedFilteredOrdersCsv()} className="px-3 py-2 rounded-lg border text-sm text-slate-700 flex items-center">
            <Download size={14} className="mr-1" /> Export Filtered Orders CSV
          </button>
          <button
            onClick={exportCustomerBreakdownCsv}
            disabled={!selectedCustomerName}
            className="px-3 py-2 rounded-lg border text-sm text-slate-700 flex items-center disabled:opacity-50"
          >
            <Download size={14} className="mr-1" /> Export Customer Breakdown CSV
          </button>
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        <div className="px-4 py-3 border-b bg-slate-50 font-semibold text-slate-700 flex items-center justify-between">
          <span>Orders ({filteredOrders.length})</span>
          <div className="text-xs text-slate-500 flex gap-2">
            <button className="px-2 py-1 border rounded" onClick={() => setAllFilteredSelection(filteredOrders, true)}>Select all shown</button>
            <button className="px-2 py-1 border rounded" onClick={() => setAllFilteredSelection(filteredOrders, false)}>Clear selected</button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 sticky top-0">
              <tr>
                {['', '', 'Date', 'Customer', 'Doc Type', 'Doc Number', 'Total Amount', '# Lines'].map(h => (
                  <th key={h} className="text-left px-3 py-2 text-xs uppercase text-slate-500">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredOrders.map(order => (
                <React.Fragment key={order.id}>
                  <tr className="border-t hover:bg-slate-50">
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={selectedOrderIds.has(order.id)}
                        onChange={() => toggleSelectedOrder(order.id)}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <button className="p-1 border rounded" onClick={() => toggleExpanded(order.id)}>
                        {expandedOrderIds.has(order.id) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </button>
                    </td>
                    <td className="px-3 py-2">{order.docDate}</td>
                    <td className="px-3 py-2">
                      <button className="text-blue-700 hover:underline" onClick={() => setSelectedCustomerName(order.customerNameRaw)}>
                        {order.customerNameRaw}
                      </button>
                    </td>
                    <td className="px-3 py-2">
                      <span className={`px-2 py-0.5 rounded text-xs ${order.isCredit ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-700'}`}>
                        {order.docType || 'Unknown'}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <button className="text-blue-700 hover:underline" onClick={() => setSelectedOrderId(order.id)}>
                        {order.docNumber || '—'}
                      </button>
                    </td>
                    <td className={`px-3 py-2 font-semibold ${order.displayTotal < 0 ? 'text-amber-700' : 'text-slate-800'}`}>{money(order.displayTotal)}</td>
                    <td className="px-3 py-2">{order.lineCount}</td>
                  </tr>

                  {expandedOrderIds.has(order.id) && (
                    <tr className="border-t bg-slate-50/50">
                      <td colSpan={8} className="px-3 py-3">
                        <div className="overflow-x-auto border rounded-lg bg-white">
                          <table className="w-full text-xs">
                            <thead className="bg-slate-50">
                              <tr>
                                {['Product', 'Qty', 'Unit', 'Amount', 'Memo/Pack'].map(h => (
                                  <th key={h} className="text-left px-3 py-2 uppercase text-slate-500">{h}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {order.lines.map(line => {
                                const rawDifferent = normalizeNameKey(line.productNameRaw) !== normalizeNameKey(line.productNameNormalizedResolved);
                                const packInfo = parsePackInfo(line.memoResolved);
                                return (
                                  <tr key={line.id} className="border-t">
                                    <td className="px-3 py-2">
                                      <div className="font-medium text-slate-800">{line.productNameNormalizedResolved}</div>
                                      {rawDifferent && <div className="text-[11px] text-slate-500">raw: {line.productNameRaw}</div>}
                                    </td>
                                    <td className="px-3 py-2">{line.signedQty.toLocaleString()}</td>
                                    <td className="px-3 py-2">{line.uomResolved || '—'}</td>
                                    <td className={`px-3 py-2 ${line.signedAmount < 0 ? 'text-amber-700' : ''}`}>{money(line.signedAmount)}</td>
                                    <td className="px-3 py-2">
                                      {line.memoResolved || '—'}
                                      {(line.derivedKg || packInfo.derivedKg) && (
                                        <div className="text-[11px] text-slate-500">derived: {(line.derivedKg || packInfo.derivedKg)?.toLocaleString()} kg</div>
                                      )}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {selectedCustomerName && (
        <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-xl font-bold text-slate-800">Customer Detail: {selectedCustomerName}</h3>
              <p className="text-sm text-slate-500">Orders: {customerTotals.orderCount} • Net Amount: {money(customerTotals.revenue)}</p>
            </div>
            <button className="p-2 border rounded" onClick={() => setSelectedCustomerName('')}><X size={14} /></button>
          </div>

          <div className="overflow-x-auto border rounded-lg">
            <table className="w-full text-sm">
              <thead className="bg-slate-50">
                <tr>
                  {['Date', 'Doc Type', 'Doc #', 'Total'].map(h => (
                    <th key={h} className="text-left px-3 py-2 text-xs uppercase text-slate-500">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {selectedCustomerOrders.map(order => (
                  <tr key={order.id} className="border-t">
                    <td className="px-3 py-2">{order.docDate}</td>
                    <td className="px-3 py-2">{order.docType}</td>
                    <td className="px-3 py-2">
                      <button className="text-blue-700 hover:underline" onClick={() => setSelectedOrderId(order.id)}>
                        {order.docNumber || '—'}
                      </button>
                    </td>
                    <td className="px-3 py-2">{money(order.displayTotal)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div>
            <h4 className="font-semibold text-slate-800 mb-2">Product Breakdown Summary</h4>
            <div className="overflow-x-auto border rounded-lg">
              <table className="w-full text-sm">
                <thead className="bg-slate-50">
                  <tr>
                    {['Product', 'Total Qty', 'Total Amount', '% Share of Spend'].map(h => (
                      <th key={h} className="text-left px-3 py-2 text-xs uppercase text-slate-500">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {customerProductBreakdown.map(row => (
                    <tr key={row.product} className="border-t">
                      <td className="px-3 py-2">{row.product}</td>
                      <td className="px-3 py-2">{row.qty.toLocaleString()}</td>
                      <td className="px-3 py-2">{money(row.amount)}</td>
                      <td className="px-3 py-2">{row.share.toFixed(2)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-slate-500 mt-2">
              Top products: {customerProductBreakdown.slice(0, 3).map(row => row.product).join(', ') || '—'}
            </p>
          </div>
        </div>
      )}

      {selectedOrderDetail && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-4xl max-h-[90vh] overflow-hidden border border-slate-200">
            <div className="px-5 py-4 border-b flex items-start justify-between">
              <div>
                <h3 className="text-xl font-bold text-slate-800">Order Detail</h3>
                <p className="text-sm text-slate-500">
                  {selectedOrderDetail.customerNameRaw} • {selectedOrderDetail.docType} • {selectedOrderDetail.docNumber || '—'} • {selectedOrderDetail.docDate}
                </p>
              </div>
              <button className="p-2 border rounded" onClick={() => setSelectedOrderId('')}><X size={14} /></button>
            </div>

            <div className="p-5 space-y-4 overflow-y-auto max-h-[70vh]">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                <div className="p-3 rounded-lg border bg-slate-50"><span className="text-slate-500">Customer</span><div className="font-semibold">{selectedOrderDetail.customerNameRaw}</div></div>
                <div className="p-3 rounded-lg border bg-slate-50"><span className="text-slate-500">Doc Type</span><div className="font-semibold">{selectedOrderDetail.docType}</div></div>
                <div className="p-3 rounded-lg border bg-slate-50"><span className="text-slate-500">Doc Number</span><div className="font-semibold">{selectedOrderDetail.docNumber || '—'}</div></div>
                <div className="p-3 rounded-lg border bg-slate-50"><span className="text-slate-500">Doc Date</span><div className="font-semibold">{selectedOrderDetail.docDate}</div></div>
              </div>

              <div className="overflow-x-auto border rounded-lg">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50">
                    <tr>
                      {['Product', 'Raw Product', 'Qty', 'Unit', 'Unit Price', 'Amount', 'Memo/Pack'].map(h => (
                        <th key={h} className="text-left px-3 py-2 text-xs uppercase text-slate-500">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {selectedOrderDetail.lines.map(line => (
                      <tr key={line.id} className="border-t">
                        <td className="px-3 py-2">{line.productNameNormalizedResolved}</td>
                        <td className="px-3 py-2 text-slate-500">{line.productNameRaw}</td>
                        <td className="px-3 py-2">{line.signedQty.toLocaleString()}</td>
                        <td className="px-3 py-2">{line.uomResolved || '—'}</td>
                        <td className="px-3 py-2">{money(line.unitPrice)}</td>
                        <td className="px-3 py-2">{money(line.signedAmount)}</td>
                        <td className="px-3 py-2">{line.memoResolved || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="p-4 rounded-lg border bg-slate-50 flex items-center justify-between">
                <div className="text-sm text-slate-500">Order Total</div>
                <div className={`text-lg font-bold ${selectedOrderDetail.displayTotal < 0 ? 'text-amber-700' : 'text-slate-800'}`}>{money(selectedOrderDetail.displayTotal)}</div>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        <div className="px-4 py-3 border-b bg-slate-50 font-semibold text-slate-700">Import History ({batches.length})</div>
        <div className="max-h-72 overflow-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 sticky top-0">
              <tr>
                {['File', 'Date', 'Orders', 'Lines', 'Format', 'Actions'].map(h => <th key={h} className="text-left px-3 py-2 text-xs uppercase text-slate-500">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {batches.map(batch => (
                <tr key={batch.id} className="border-t">
                  <td className="px-3 py-2">{batch.fileName}</td>
                  <td className="px-3 py-2">{new Date(batch.createdAt).toLocaleString()}</td>
                  <td className="px-3 py-2">{batch.ordersCreated}</td>
                  <td className="px-3 py-2">{batch.linesCreated}</td>
                  <td className="px-3 py-2">{batch.formatDetected}</td>
                  <td className="px-3 py-2">
                    <button onClick={() => void deleteBatch(batch.id)} className="px-2 py-1 text-xs rounded border border-red-200 text-red-700 flex items-center">
                      <Trash2 size={12} className="mr-1" /> Delete Import Batch
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {orders.length === 0 && (
        <div className="bg-white rounded-2xl border border-slate-200 p-8 text-slate-500">
          No orders imported yet. Use Import Wizard to load QuickBooks Sales by Product/Service Detail data.
        </div>
      )}

      {customers.length > 0 && (
        <div className="text-xs text-slate-400">
          Customers loaded: {customers.length}
        </div>
      )}
    </div>
  );
};

export default SalesOrdersView;
