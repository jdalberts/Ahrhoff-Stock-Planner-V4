import React, { useState } from 'react';
import { InventoryLot, Item, StockCountEntry } from './types';
import { COUNT_REASONS } from './constants';
import { db } from './db';
import { ClipboardCheck, Save, Search, CheckCircle, Upload, FileSpreadsheet } from 'lucide-react';

declare global {
  interface Window {
    XLSX?: any;
  }
}

interface Props {
  lots: InventoryLot[];
  items: Item[];
  onRefresh: () => void;
}

interface ParsedStockWorksheetRow {
  id: string;
  productName: string;
  qtyOnHand: number;
  skip: boolean;
}

const uid = (): string => Date.now().toString(36) + Math.random().toString(36).slice(2, 9);

const normalize = (value: string): string => value.toLowerCase().replace(/\s+/g, ' ').trim();

const toNumber = (value: any): number => {
  const raw = String(value ?? '').trim();
  if (!raw) return 0;
  let cleaned = raw.replace(/\s+/g, '');
  if (cleaned.includes(',') && cleaned.includes('.')) {
    cleaned = cleaned.replace(/,/g, '');
  } else if (cleaned.includes(',') && !cleaned.includes('.')) {
    cleaned = cleaned.replace(/,/g, '.');
  }
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
};

const StockTake: React.FC<Props> = ({ lots, items, onRefresh }) => {
  const [selectedLotId, setSelectedLotId] = useState('');
  const [countedQty, setCountedQty] = useState('');
  const [reason, setReason] = useState<'adjustment' | 'damage' | 'correction' | 'routine'>('routine');
  const [notes, setNotes] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [stockFileName, setStockFileName] = useState('');
  const [parsedWorksheetRows, setParsedWorksheetRows] = useState<ParsedStockWorksheetRow[]>([]);
  const [isImportingWorksheet, setIsImportingWorksheet] = useState(false);
  // FIX (Issue 6): Inline status messages instead of alert()
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const getItemName = (id: string) => items.find(i => i.id === id)?.name || 'Unknown';

  const availableLots = lots
    .filter(l => l.status === 'available')
    .filter(l => {
      const name = getItemName(l.itemId).toLowerCase();
      const num = l.lotNumber.toLowerCase();
      return name.includes(searchTerm.toLowerCase()) || num.includes(searchTerm.toLowerCase());
    });

  const handleSave = async () => {
    setStatusMessage(null);

    // FIX (Issue 8): Proper validation
    if (!selectedLotId) {
      setStatusMessage({ type: 'error', text: 'Please select a lot to count.' });
      return;
    }
    if (countedQty === '' || Number(countedQty) < 0) {
      setStatusMessage({ type: 'error', text: 'Please enter a valid counted quantity (0 or greater).' });
      return;
    }

    setIsSubmitting(true);
    try {
      const lot = lots.find(l => l.id === selectedLotId);
      if (!lot) throw new Error("Lot not found");

      // 1) Record Audit Entry
      const entry: StockCountEntry = {
        id: crypto.randomUUID(),
        date: new Date().toISOString(),
        lotId: selectedLotId,
        countedQty: Number(countedQty),
        reason,
        notes
      };
      await db.put('stockCounts', entry);

      // 2) Update Lot Qty
      const updatedLot: InventoryLot = {
        ...lot,
        quantityRemaining: Number(countedQty)
      };
      await db.put('lots', updatedLot);

      // Reset
      setSelectedLotId('');
      setCountedQty('');
      setNotes('');
      setReason('routine');
      onRefresh();
      setStatusMessage({ type: 'success', text: 'Stock count updated successfully!' });
      
      // Clear success message after 4 seconds
      setTimeout(() => setStatusMessage(null), 4000);
    } catch (err) {
      console.error(err);
      setStatusMessage({ type: 'error', text: 'Error updating stock count. Please try again.' });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleWorksheetFile = async (file: File) => {
    setStatusMessage(null);
    setParsedWorksheetRows([]);
    setStockFileName(file.name);

    if (!window.XLSX) {
      setStatusMessage({ type: 'error', text: 'Spreadsheet parser is not available. Refresh and try again.' });
      return;
    }

    try {
      const data = await file.arrayBuffer();
      const workbook = window.XLSX.read(data, { type: 'array' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const raw: any[][] = window.XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

      let headerIdx = -1;
      for (let index = 0; index < Math.min(raw.length, 20); index++) {
        const row = (raw[index] || []).map((cell: any) => String(cell || '').toLowerCase().trim());
        const joined = row.join(' | ');
        if (joined.includes('product/service') && (joined.includes('qty on hand') || joined.includes('quantity on hand'))) {
          headerIdx = index;
          break;
        }
      }

      if (headerIdx < 0) {
        setStatusMessage({ type: 'error', text: 'Could not find Product/Service and Qty on Hand headers.' });
        return;
      }

      const headers = (raw[headerIdx] || []).map((cell: any) => String(cell || '').toLowerCase().trim());
      const productCol = headers.findIndex((header: string) => header.includes('product/service') || header.includes('product') || header.includes('service'));
      const qtyCol = headers.findIndex((header: string) => header.includes('qty on hand') || header.includes('quantity on hand') || header.includes('qty'));

      const parsed: ParsedStockWorksheetRow[] = [];
      for (let rowIndex = headerIdx + 1; rowIndex < raw.length; rowIndex++) {
        const row = raw[rowIndex] || [];
        const productName = String(row[productCol >= 0 ? productCol : 0] || '').trim();
        if (!productName) continue;
        if (productName.toUpperCase() === 'TOTAL') break;

        parsed.push({
          id: `${rowIndex}_${productName}`,
          productName,
          qtyOnHand: Math.max(0, toNumber(row[qtyCol >= 0 ? qtyCol : 4])),
          skip: false,
        });
      }

      if (parsed.length === 0) {
        setStatusMessage({ type: 'error', text: 'No stock rows found below header row.' });
        return;
      }

      setParsedWorksheetRows(parsed);
      setStatusMessage({ type: 'success', text: `Loaded ${parsed.length} stock rows from worksheet.` });
    } catch (err) {
      console.error(err);
      setStatusMessage({ type: 'error', text: 'Could not read worksheet file. Please use a valid XLSX/XLS file.' });
    }
  };

  const toggleWorksheetRow = (rowId: string) => {
    setParsedWorksheetRows(prev => prev.map(row => row.id === rowId ? { ...row, skip: !row.skip } : row));
  };

  const importWorksheetStock = async () => {
    const activeRows = parsedWorksheetRows.filter(row => !row.skip);
    if (activeRows.length === 0) {
      setStatusMessage({ type: 'error', text: 'No worksheet rows selected for import.' });
      return;
    }

    setIsImportingWorksheet(true);
    setStatusMessage(null);

    try {
      const allLots = await db.getAll<InventoryLot>('lots');
      const itemByName = new Map(items.map(item => [normalize(item.name), item]));
      const today = new Date().toISOString().split('T')[0];

      let itemsCreated = 0;
      let productsUpdated = 0;
      let lotsCreated = 0;

      for (const row of activeRows) {
        const key = normalize(row.productName);
        let item = itemByName.get(key);

        if (!item) {
          item = {
            id: uid(),
            skuCode: `AUTO-${row.productName.replace(/[^a-zA-Z0-9]+/g, '-').toUpperCase().slice(0, 24)}`,
            name: row.productName,
            category: 'Other',
            packSize: 1,
            leadTimeDays: 60,
            moq: 1000,
            costPerUnit: 0,
          };
          await db.put('items', item);
          itemByName.set(key, item);
          itemsCreated += 1;
        } else {
          productsUpdated += 1;
        }

        const existingAvailableLots = allLots.filter(lot => lot.itemId === item.id && lot.status === 'available');
        for (const lot of existingAvailableLots) {
          const updated: InventoryLot = { ...lot, quantityRemaining: 0 };
          await db.put('lots', updated);
        }

        const newLot: InventoryLot = {
          id: uid(),
          itemId: item.id,
          lotNumber: `STOCKTAKE-${today}-${uid().slice(-4).toUpperCase()}`,
          expiryDate: null,
          quantityRemaining: row.qtyOnHand,
          receivedDate: today,
          quantityReceived: row.qtyOnHand,
          status: 'available',
          notes: `Imported from stock worksheet: ${stockFileName || 'manual upload'}`,
        };
        await db.put('lots', newLot);
        lotsCreated += 1;
      }

      await onRefresh();
      setParsedWorksheetRows([]);
      setStockFileName('');
      setStatusMessage({
        type: 'success',
        text: `Stock imported: ${activeRows.length} rows applied, ${lotsCreated} lots created, ${itemsCreated} new products.`
      });
    } catch (err) {
      console.error(err);
      setStatusMessage({ type: 'error', text: 'Stock worksheet import failed. Please try again.' });
    } finally {
      setIsImportingWorksheet(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto space-y-8">
      <div>
        <h2 className="text-3xl font-bold text-slate-800 mb-2 flex items-center">
          <ClipboardCheck className="text-green-600 mr-3" size={32} />
          Fast Stock Take
        </h2>
        <p className="text-slate-500">Update warehouse quantities quickly. Every entry is logged for audit history.</p>
      </div>

      {/* FIX: Inline status messages instead of browser alert() */}
      {statusMessage && (
        <div className={`p-4 rounded-xl text-sm font-medium flex items-center ${
          statusMessage.type === 'success' 
            ? 'bg-green-50 border border-green-200 text-green-700' 
            : 'bg-red-50 border border-red-200 text-red-600'
        }`}>
          {statusMessage.type === 'success' && <CheckCircle size={18} className="mr-2 flex-shrink-0" />}
          {statusMessage.text}
        </div>
      )}

      <div className="bg-white p-8 rounded-2xl border border-slate-200 shadow-sm space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-lg font-bold text-slate-800 flex items-center">
              <FileSpreadsheet size={18} className="mr-2 text-blue-600" />
              Upload Current Stock on Hand
            </h3>
            <p className="text-sm text-slate-500">Import Xero Stocktake Worksheet and apply Qty on Hand as current stock.</p>
          </div>
          <label className="inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg font-semibold cursor-pointer text-sm">
            <Upload size={16} className="mr-2" /> Upload Worksheet
            <input
              type="file"
              accept=".xlsx,.xls"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void handleWorksheetFile(file);
              }}
            />
          </label>
        </div>

        <div className="p-3 rounded-xl border border-blue-200 bg-blue-50 text-blue-800 text-xs">
          Upload your <b>Xero Stocktake Worksheet</b> here to set current stock on hand. Use <b>Import Wizard</b> for sales/order transaction files.
        </div>

        {stockFileName && (
          <p className="text-xs text-slate-500">Loaded file: {stockFileName}</p>
        )}

        {parsedWorksheetRows.length > 0 && (
          <>
            <div className="text-xs text-slate-500">
              Click rows to exclude/include. Selected: <b>{parsedWorksheetRows.filter(row => !row.skip).length}</b> / {parsedWorksheetRows.length}
            </div>
            <div className="max-h-56 overflow-auto border rounded-xl">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 sticky top-0">
                  <tr>
                    <th className="text-left px-3 py-2 text-xs uppercase text-slate-500">Use</th>
                    <th className="text-left px-3 py-2 text-xs uppercase text-slate-500">Product</th>
                    <th className="text-right px-3 py-2 text-xs uppercase text-slate-500">Qty on Hand</th>
                  </tr>
                </thead>
                <tbody>
                  {parsedWorksheetRows.slice(0, 80).map(row => (
                    <tr
                      key={row.id}
                      onClick={() => toggleWorksheetRow(row.id)}
                      className={`border-t cursor-pointer ${row.skip ? 'bg-slate-100 text-slate-400 line-through' : ''}`}
                    >
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          checked={!row.skip}
                          onClick={(event) => event.stopPropagation()}
                          onChange={() => toggleWorksheetRow(row.id)}
                        />
                      </td>
                      <td className="px-3 py-2">{row.productName}</td>
                      <td className="px-3 py-2 text-right">{row.qtyOnHand}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-slate-500">
              Import updates each selected product to this worksheet snapshot by zeroing existing available lots and creating a new stocktake lot.
            </p>
            <button
              onClick={() => void importWorksheetStock()}
              disabled={isImportingWorksheet}
              className="w-full py-3 bg-blue-600 text-white font-bold rounded-xl hover:bg-blue-700 transition-all disabled:opacity-50"
            >
              {isImportingWorksheet ? 'Applying Stock Snapshot...' : 'Apply Stock on Hand from Worksheet'}
            </button>
          </>
        )}
      </div>

      <div className="bg-white p-8 rounded-2xl border border-slate-200 shadow-sm space-y-6">
        {/* Lot Selection with search */}
        <div>
          <label className="block text-sm font-bold text-slate-700 mb-2 uppercase tracking-wide">Select Lot to Count</label>
          <div className="relative mb-3">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
            <input 
              type="text" 
              placeholder="Filter lots by item name or lot #..."
              className="w-full pl-10 pr-4 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-green-600/20"
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-1 gap-2 max-h-60 overflow-y-auto pr-2">
            {availableLots.map(l => (
              <button
                key={l.id}
                onClick={() => { setSelectedLotId(l.id); setStatusMessage(null); }}
                className={`flex items-center justify-between p-4 rounded-xl border text-left transition-all ${
                  selectedLotId === l.id 
                    ? 'border-green-600 bg-green-50 ring-2 ring-green-600/10' 
                    : 'border-slate-100 hover:border-slate-300 bg-slate-50'
                }`}
              >
                <div>
                  <p className="font-bold text-slate-800">{getItemName(l.itemId)}</p>
                  <p className="text-xs text-slate-500">Lot: {l.lotNumber} | Current: {l.quantityRemaining}</p>
                </div>
                {selectedLotId === l.id && <div className="w-5 h-5 bg-green-600 rounded-full flex items-center justify-center text-white"><Save size={12}/></div>}
              </button>
            ))}
            {availableLots.length === 0 && <p className="text-center py-4 text-slate-400">No matching lots found.</p>}
          </div>
        </div>

        {selectedLotId && (
          <div className="pt-6 border-t border-slate-100 space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label className="block text-sm font-bold text-slate-700 mb-2 uppercase tracking-wide">Counted Quantity *</label>
                <input 
                  type="number"
                  min="0"
                  placeholder="Enter exact count..."
                  className="w-full px-4 py-3 text-lg font-bold border border-slate-200 rounded-xl focus:ring-2 focus:ring-green-600/20"
                  value={countedQty}
                  onChange={e => setCountedQty(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-sm font-bold text-slate-700 mb-2 uppercase tracking-wide">Reason</label>
                <select
                  className="w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-green-600/20 bg-white"
                  value={reason}
                  onChange={e => setReason(e.target.value as typeof reason)}
                >
                  {COUNT_REASONS.map(r => <option key={r} value={r}>{r.charAt(0).toUpperCase() + r.slice(1)}</option>)}
                </select>
              </div>
            </div>

            <div>
              <label className="block text-sm font-bold text-slate-700 mb-2 uppercase tracking-wide">Notes (Optional)</label>
              <textarea 
                placeholder="e.g. Minor bag damage, standard check..."
                className="w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-green-600/20 h-24"
                value={notes}
                onChange={e => setNotes(e.target.value)}
              />
            </div>

            <button
              onClick={handleSave}
              disabled={isSubmitting}
              className="w-full py-4 bg-green-600 text-white font-bold rounded-xl shadow-lg hover:bg-green-700 active:scale-[0.98] transition-all flex items-center justify-center disabled:opacity-50"
            >
              <Save size={20} className="mr-2" />
              {isSubmitting ? 'Updating DB...' : 'Save Stock Count'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default StockTake;
