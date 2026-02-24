import React, { useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle, FileSpreadsheet, Upload, X } from 'lucide-react';
import { db } from './db';
import { CustomerV5, ImportBatchV5, NormalizedTransaction, OrderLineV5, OrderV5, ParseResult, ProductV5 } from './types';
import { detectFormat, parseByFormat, parseWorkbook, WorkbookParseResult } from './src/import/parsers';
import { normalizeProductName, parsePackInfo } from './productNormalization';

type Step = 1 | 2 | 3 | 4 | 5 | 6;
type DuplicateChoice = 'importAll' | 'merge' | 'replace' | 'cancel';
type DuplicateRowAction = 'useGlobal' | 'merge' | 'replace' | 'importNew' | 'skip';

interface AggregatedOrder {
  key: string;
  docNumber: string;
  customerName: string;
  docDate: string;
  docType: string;
  lines: NormalizedTransaction[];
  total: number;
}

interface DuplicateReviewRow {
  incoming: AggregatedOrder;
  existing: OrderV5;
  existingLineCount: number;
}

interface Props {
  onImported?: () => Promise<void> | void;
}

const uid = (): string => Date.now().toString(36) + Math.random().toString(36).slice(2, 9);

const normalizeText = (value: string): string => value.toLowerCase().replace(/\s+/g, ' ').trim();

const csvEscape = (value: string | number): string => {
  const raw = String(value ?? '');
  if (/[,"\n]/.test(raw)) return `"${raw.replace(/"/g, '""')}"`;
  return raw;
};

const toOrderKey = (tx: NormalizedTransaction): string => {
  return `${normalizeText(tx.number || '')}|${normalizeText(tx.customerName)}|${tx.transactionDate}|${normalizeText(tx.transactionType || '')}`;
};

const aggregateOrders = (transactions: NormalizedTransaction[]): AggregatedOrder[] => {
  const grouped = new Map<string, NormalizedTransaction[]>();
  for (const tx of transactions) {
    const key = toOrderKey(tx);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(tx);
  }

  const orders = [...grouped.entries()].map(([key, lines]) => {
    const sample = lines[0];
    const total = lines.reduce((sum, line) => sum + Number(line.amount || 0), 0);
    return {
      key,
      docNumber: sample.number || '',
      customerName: sample.customerName,
      docDate: sample.transactionDate,
      docType: sample.transactionType || 'Unknown',
      lines,
      total,
    };
  });

  return orders;
};

const isDuplicateOrder = (existing: OrderV5, incoming: AggregatedOrder): boolean => {
  const sameDoc = normalizeText(existing.docNumber || '') === normalizeText(incoming.docNumber || '');
  const sameCustomer = normalizeText(existing.customerNameRaw) === normalizeText(incoming.customerName);
  const sameDate = existing.docDate === incoming.docDate;
  const sameDocType = normalizeText(existing.docType || '') === normalizeText(incoming.docType || '');
  const amountNear = Math.abs(Number(existing.total || 0) - Number(incoming.total || 0)) < 0.01;
  return sameDoc && sameCustomer && sameDate && sameDocType && amountNear;
};

const lineSignature = (line: {
  productNameRaw?: string;
  productService?: string;
  memo?: string;
  qty?: number;
  quantity?: number;
  unitPrice?: number;
  amount?: number;
}): string => {
  const product = normalizeText(line.productNameRaw || line.productService || '');
  const memo = normalizeText(line.memo || '');
  const qty = Number(line.qty ?? line.quantity ?? 0).toFixed(4);
  const price = Number(line.unitPrice ?? 0).toFixed(4);
  const amount = Number(line.amount ?? 0).toFixed(4);
  return `${product}|${memo}|${qty}|${price}|${amount}`;
};

const resolveDuplicateAction = (
  globalChoice: DuplicateChoice,
  overrideAction: DuplicateRowAction | undefined,
  hasDuplicate: boolean
): 'merge' | 'replace' | 'importNew' | 'skip' | 'cancel' => {
  if (!hasDuplicate) return 'importNew';
  if (overrideAction && overrideAction !== 'useGlobal') {
    return overrideAction;
  }
  if (globalChoice === 'importAll') return 'importNew';
  return globalChoice;
};

const downloadCsv = (fileName: string, header: string[], rows: Array<Array<string | number>>) => {
  const csv = [header.join(','), ...rows.map(row => row.map(csvEscape).join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
};

const ImportWizard: React.FC<Props> = ({ onImported }) => {
  const [step, setStep] = useState<Step>(1);
  const [file, setFile] = useState<File | null>(null);
  const [workbook, setWorkbook] = useState<WorkbookParseResult | null>(null);
  const [selectedSheet, setSelectedSheet] = useState(0);
  const [parseResult, setParseResult] = useState<ParseResult | null>(null);
  const [debugMode, setDebugMode] = useState<boolean>(() => localStorage.getItem('import_debug_mode') === '1');
  const [busy, setBusy] = useState(false);
  const [fatalError, setFatalError] = useState('');
  const [duplicateChoice, setDuplicateChoice] = useState<DuplicateChoice>(() => {
    const saved = localStorage.getItem('import_duplicate_choice') as DuplicateChoice | null;
    return saved || 'importAll';
  });
  const [importSummary, setImportSummary] = useState<{ ordersCreated: number; linesCreated: number; duplicates: number } | null>(null);
  const [duplicateReviewRows, setDuplicateReviewRows] = useState<DuplicateReviewRow[]>([]);
  const [duplicateRowActions, setDuplicateRowActions] = useState<Record<string, DuplicateRowAction>>({});

  const sheetRows = workbook?.sheets[selectedSheet]?.rows || [];
  const detection = useMemo(() => detectFormat(sheetRows), [sheetRows]);

  const parsedPreview = useMemo(() => {
    if (!parseResult) return [];
    return parseResult.transactions.slice(0, 50);
  }, [parseResult]);

  const previewStats = useMemo(() => {
    if (!parseResult) return { totalRows: 0, ordersDetected: 0, customersDetected: 0 };
    const grouped = aggregateOrders(parseResult.transactions);
    return {
      totalRows: parseResult.transactions.length,
      ordersDetected: grouped.length,
      customersDetected: new Set(parseResult.transactions.map(tx => normalizeText(tx.customerName))).size,
    };
  }, [parseResult]);

  const duplicateActionSummary = useMemo(() => {
    const summary = {
      merge: 0,
      replace: 0,
      importNew: 0,
      skip: 0,
      cancel: 0,
    };

    for (const row of duplicateReviewRows) {
      const action = resolveDuplicateAction(
        duplicateChoice,
        duplicateRowActions[row.incoming.key],
        true
      );
      summary[action] += 1;
    }

    return summary;
  }, [duplicateReviewRows, duplicateChoice, duplicateRowActions]);

  const reset = () => {
    setStep(1);
    setFile(null);
    setWorkbook(null);
    setSelectedSheet(0);
    setParseResult(null);
    setFatalError('');
    setImportSummary(null);
    setDuplicateReviewRows([]);
    setDuplicateRowActions({});
  };

  const handleFile = async (selected: File) => {
    setBusy(true);
    setFatalError('');
    setImportSummary(null);

    try {
      const result = await parseWorkbook(selected);
      setFile(selected);
      setWorkbook(result);
      setSelectedSheet(0);
      setStep(result.sheets.length > 1 ? 2 : 3);
    } catch (err: any) {
      setFatalError(err?.message || 'Failed to read file.');
    } finally {
      setBusy(false);
    }
  };

  const continueAutoDetect = () => {
    if (!workbook) return;
    setStep(3);
  };

  const runParse = () => {
    if (!workbook) return;
    const sheet = workbook.sheets[selectedSheet];
    const result = parseByFormat(sheet.rows, detection.format, {
      fileName: workbook.fileName,
      sheetName: sheet.name,
      debug: debugMode,
    });

    if (debugMode) {
      console.log('[import] format detection', detection);
      console.log('[import] parsed transactions', result.transactions.length);
    }

    setParseResult(result);
    setStep(4);
  };

  const continueToConfirm = () => {
    if (!parseResult) return;

    void (async () => {
      const groupedOrders = aggregateOrders(parseResult.transactions);
      const existingOrders = await db.getAll<OrderV5>('orders');
      const existingLines = await db.getAll<OrderLineV5>('order_lines');

      const rows: DuplicateReviewRow[] = [];
      for (const incoming of groupedOrders) {
        const existing = existingOrders.find(order => isDuplicateOrder(order, incoming));
        if (!existing) continue;
        rows.push({
          incoming,
          existing,
          existingLineCount: existingLines.filter(line => line.orderId === existing.id).length,
        });
      }

      setDuplicateReviewRows(rows);
      const defaults: Record<string, DuplicateRowAction> = {};
      for (const row of rows) {
        defaults[row.incoming.key] = 'useGlobal';
      }
      setDuplicateRowActions(defaults);
      setStep(5);
    })();
  };

  const continueFromDuplicateReview = () => {
    setStep(6);
  };

  const executeImport = async () => {
    if (!parseResult || !workbook) return;

    setBusy(true);
    setFatalError('');

    try {
      const validRows: NormalizedTransaction[] = [];
      const warnings = [...parseResult.warnings];

      for (const tx of parseResult.transactions) {
        if (!tx.transactionDate) {
          warnings.push(`Skipped row: missing date for ${tx.customerName || 'unknown customer'}.`);
          continue;
        }
        if (!tx.customerName) {
          warnings.push(`Skipped row: missing customer on ${tx.transactionDate}.`);
          continue;
        }
        validRows.push(tx);
      }

      const groupedOrders = aggregateOrders(validRows);
      const existingOrders = await db.getAll<OrderV5>('orders');
      const existingLines = await db.getAll<OrderLineV5>('order_lines');
      const existingCustomers = await db.getAll<CustomerV5>('customers');
      const existingProducts = await db.getAll<ProductV5>('products');

      const duplicateMap = new Map<string, OrderV5>();
      for (const incoming of groupedOrders) {
        const duplicate = existingOrders.find(order => isDuplicateOrder(order, incoming));
        if (duplicate) duplicateMap.set(incoming.key, duplicate);
      }

      const customerByName = new Map(existingCustomers.map(c => [normalizeText(c.name), c]));
      const productByName = new Map(existingProducts.map(p => [normalizeText(p.name), p]));

      const now = new Date().toISOString();
      const batchId = uid();
      let ordersCreated = 0;
      let linesCreated = 0;

      const batch: ImportBatchV5 = {
        id: batchId,
        fileName: workbook.fileName,
        sheetName: workbook.sheets[selectedSheet].name,
        formatDetected: parseResult.metadata.formatDetected,
        confidence: parseResult.metadata.confidence,
        rowCountRaw: validRows.length,
        ordersCreated: 0,
        linesCreated: 0,
        warnings,
        createdAt: now,
      };
      await db.put('import_batches', batch);

      for (const incoming of groupedOrders) {
        const duplicate = duplicateMap.get(incoming.key);
        const effectiveAction = resolveDuplicateAction(
          duplicateChoice,
          duplicateRowActions[incoming.key],
          Boolean(duplicate)
        );

        if (effectiveAction === 'cancel') {
          setFatalError('Import cancelled because duplicate handling is set to Cancel.');
          setBusy(false);
          return;
        }

        if (effectiveAction === 'skip') {
          continue;
        }

        if (duplicate && effectiveAction === 'replace') {
          const toDelete = existingLines.filter(line => line.orderId === duplicate.id);
          for (const line of toDelete) {
            await db.delete('order_lines', line.id);
          }
          await db.delete('orders', duplicate.id);
        }

        let targetOrderId = effectiveAction === 'merge' ? duplicate?.id : undefined;

        if (!duplicate || effectiveAction === 'importNew' || effectiveAction === 'replace') {
          const customerKey = normalizeText(incoming.customerName);
          let customer = customerByName.get(customerKey);
          if (!customer) {
            customer = {
              id: uid(),
              name: incoming.customerName,
              aliases: [],
              tags: [],
              createdAt: now,
              updatedAt: now,
            };
            customerByName.set(customerKey, customer);
            await db.put('customers', customer);
          }

          const newOrder: OrderV5 = {
            id: uid(),
            docNumber: incoming.docNumber,
            docType: incoming.docType,
            docDate: incoming.docDate,
            customerId: customer.id,
            customerNameRaw: incoming.customerName,
            subtotal: incoming.total,
            total: incoming.total,
            status: 'imported',
            importBatchId: batchId,
            hashKey: incoming.key,
            createdAt: now,
            updatedAt: now,
          };

          await db.put('orders', newOrder);
          targetOrderId = newOrder.id;
          ordersCreated += 1;

          if (debugMode) {
            console.log('[import] order created', newOrder.docNumber, newOrder.customerNameRaw);
          }
        }

        if (!targetOrderId) continue;

        const existingLineSignatures = new Set<string>();
        if (duplicate && effectiveAction === 'merge') {
          const duplicateLines = existingLines.filter(line => line.orderId === duplicate.id);
          for (const line of duplicateLines) {
            existingLineSignatures.add(lineSignature(line));
          }
        }

        let mergedAmountDelta = 0;

        for (let index = 0; index < incoming.lines.length; index++) {
          const line = incoming.lines[index];
          const normalized = normalizeProductName(line.productService);
          const packInfo = parsePackInfo(line.memo || '');

          if (duplicate && effectiveAction === 'merge') {
            const signature = lineSignature(line);
            if (existingLineSignatures.has(signature)) {
              continue;
            }
            existingLineSignatures.add(signature);
          }

          const productKey = normalizeText(line.productService);

          if (productKey && !productByName.has(productKey)) {
            const product: ProductV5 = {
              id: uid(),
              name: line.productService,
              brand: '',
              packSize: 0,
              packUom: 'unit',
              active: true,
            };
            productByName.set(productKey, product);
            await db.put('products', product);
          }

          const newLine: OrderLineV5 = {
            id: uid(),
            orderId: targetOrderId,
            productNameRaw: line.productService,
            productNameNormalized: normalized.canonical,
            memo: line.memo,
            qty: Number(line.quantity || 0),
            uom: packInfo.packUom,
            unitPrice: Number(line.unitPrice || 0),
            amount: Number(line.amount || 0),
            packCount: packInfo.packCount,
            packSize: packInfo.packSize,
            packUom: packInfo.packUom,
            packType: packInfo.packType,
            derivedKg: packInfo.derivedKg,
            sortIndex: index,
            createdAt: now,
          };

          await db.put('order_lines', newLine);
          linesCreated += 1;
          mergedAmountDelta += Number(line.amount || 0);
        }

        if (duplicate && effectiveAction === 'merge' && mergedAmountDelta > 0) {
          const updatedOrder: OrderV5 = {
            ...duplicate,
            subtotal: Number(duplicate.subtotal || 0) + mergedAmountDelta,
            total: Number(duplicate.total || 0) + mergedAmountDelta,
            updatedAt: now,
          };
          await db.put('orders', updatedOrder);
        }
      }

      const savedBatch: ImportBatchV5 = {
        ...batch,
        ordersCreated,
        linesCreated,
      };
      await db.put('import_batches', savedBatch);

      setImportSummary({ ordersCreated, linesCreated, duplicates: duplicateMap.size });
      if (onImported) await onImported();
    } catch (err: any) {
      setFatalError(err?.message || 'Import failed.');
    } finally {
      setBusy(false);
    }
  };

  const exportPreviewCsv = () => {
    if (!parseResult) return;
    const header = ['Customer', 'Date', 'Invoice', 'Product', 'Quantity', 'Amount'];
    const rows = parseResult.transactions.map(tx => [
      tx.customerName,
      tx.transactionDate,
      tx.number,
      tx.productService,
      tx.quantity,
      tx.amount,
    ]);
    downloadCsv('import_preview.csv', header, rows);
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-3xl font-bold text-slate-800 mb-2">Import Wizard</h2>
        <p className="text-slate-500">Professional Excel import pipeline with auto detection, preview, and safe import.</p>
      </div>

      {fatalError && (
        <div className="p-4 rounded-xl border border-red-200 bg-red-50 text-red-700 text-sm flex items-center">
          <AlertTriangle size={16} className="mr-2" /> {fatalError}
        </div>
      )}

      <div className="bg-white rounded-2xl border border-slate-200 p-5 flex items-center justify-between">
        <div className="text-sm text-slate-600">Step {step} of 6</div>
        <label className="text-xs flex items-center gap-2 text-slate-500">
          <input
            type="checkbox"
            checked={debugMode}
            onChange={(e) => {
              const checked = e.target.checked;
              setDebugMode(checked);
              localStorage.setItem('import_debug_mode', checked ? '1' : '0');
            }}
          />
          Debug mode
        </label>
      </div>

      {step === 1 && (
        <div className="bg-white rounded-2xl border border-slate-200 p-8">
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const dropped = e.dataTransfer.files?.[0];
              if (dropped) void handleFile(dropped);
            }}
            className="border-2 border-dashed border-slate-300 rounded-2xl p-10 text-center"
          >
            <FileSpreadsheet size={36} className="mx-auto text-blue-500 mb-4" />
            <p className="text-lg font-bold text-slate-800">Upload file</p>
            <p className="text-slate-500 text-sm mb-4">Drag & drop XLSX/CSV or browse</p>
            <label className="inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg font-semibold cursor-pointer">
              <Upload size={16} className="mr-2" /> Browse
              <input
                type="file"
                accept=".xlsx,.xls,.csv"
                className="hidden"
                onChange={(e) => {
                  const selected = e.target.files?.[0];
                  if (selected) void handleFile(selected);
                }}
              />
            </label>
            {file && (
              <p className="text-xs text-slate-500 mt-4">{file.name} ({Math.round(file.size / 1024)} KB)</p>
            )}
            {busy && <p className="text-sm text-slate-500 mt-3">Reading file...</p>}
          </div>
        </div>
      )}

      {step === 2 && workbook && (
        <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-4">
          <h3 className="text-xl font-bold text-slate-800">Select Sheet</h3>
          <select
            className="w-full border rounded-lg px-3 py-2"
            value={selectedSheet}
            onChange={(e) => setSelectedSheet(Number(e.target.value))}
          >
            {workbook.sheets.map((sheet, index) => (
              <option key={sheet.name} value={index}>{sheet.name}</option>
            ))}
          </select>
          <button onClick={continueAutoDetect} className="px-5 py-2 bg-blue-600 text-white rounded-lg font-semibold">Continue</button>
        </div>
      )}

      {step === 3 && workbook && (
        <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-4">
          <h3 className="text-xl font-bold text-slate-800">Auto Detection</h3>
          <div className="p-4 rounded-xl bg-slate-50 border border-slate-200">
            <p className="text-sm text-slate-500">Detected Format:</p>
            <p className="text-lg font-bold text-slate-800">{detection.format}</p>
            <p className="text-sm text-slate-500 mt-2">Confidence: <span className="font-semibold">{detection.confidence}%</span></p>
            <p className="text-sm text-slate-500 mt-2">Reason: {detection.reason}</p>
          </div>
          <button onClick={runParse} className="px-5 py-2 bg-blue-600 text-white rounded-lg font-semibold">Parse Sheet</button>
        </div>
      )}

      {step === 4 && parseResult && (
        <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-xl font-bold text-slate-800">Preview (first 50 rows)</h3>
            <button onClick={exportPreviewCsv} className="px-3 py-2 text-xs border rounded-lg text-slate-600">Export Preview CSV</button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
            <div className="p-3 rounded-lg border bg-slate-50">Total rows found: <b>{previewStats.totalRows}</b></div>
            <div className="p-3 rounded-lg border bg-slate-50">Orders detected: <b>{previewStats.ordersDetected}</b></div>
            <div className="p-3 rounded-lg border bg-slate-50">Customers detected: <b>{previewStats.customersDetected}</b></div>
          </div>

          <div className="overflow-x-auto border rounded-xl">
            <table className="w-full text-sm">
              <thead className="bg-slate-50">
                <tr>
                  {['Customer', 'Date', 'Invoice', 'Product', 'Quantity', 'Amount'].map(header => (
                    <th key={header} className="text-left px-3 py-2 text-xs uppercase text-slate-500">{header}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {parsedPreview.map((row, index) => (
                  <tr key={index} className="border-t">
                    <td className="px-3 py-2">{row.customerName}</td>
                    <td className="px-3 py-2">{row.transactionDate}</td>
                    <td className="px-3 py-2">{row.number}</td>
                    <td className="px-3 py-2">{row.productService}</td>
                    <td className="px-3 py-2">{row.quantity}</td>
                    <td className="px-3 py-2">{row.amount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <button onClick={continueToConfirm} className="px-5 py-2 bg-blue-600 text-white rounded-lg font-semibold">Continue</button>
        </div>
      )}

      {step === 5 && parseResult && (
        <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-4">
          <h3 className="text-xl font-bold text-slate-800">Duplicate Review</h3>

          {duplicateReviewRows.length === 0 ? (
            <div className="p-3 rounded-xl border border-green-200 bg-green-50 text-green-700 text-sm">
              No duplicates detected against existing orders.
            </div>
          ) : (
            <>
              <div className="p-3 rounded-xl border border-amber-200 bg-amber-50 text-amber-800 text-sm">
                Detected <b>{duplicateReviewRows.length}</b> potential duplicate orders.
              </div>
              <div className="overflow-x-auto border rounded-xl">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50">
                    <tr>
                      {['Customer', 'Date', 'Invoice', 'Incoming Total', 'Existing Total', 'Existing Lines', 'Action'].map(header => (
                        <th key={header} className="text-left px-3 py-2 text-xs uppercase text-slate-500">{header}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {duplicateReviewRows.map((row, index) => (
                      <tr key={`${row.existing.id}-${index}`} className="border-t">
                        <td className="px-3 py-2">{row.incoming.customerName}</td>
                        <td className="px-3 py-2">{row.incoming.docDate}</td>
                        <td className="px-3 py-2">{row.incoming.docNumber || '—'}</td>
                        <td className="px-3 py-2">{row.incoming.total.toFixed(2)}</td>
                        <td className="px-3 py-2">{Number(row.existing.total || 0).toFixed(2)}</td>
                        <td className="px-3 py-2">{row.existingLineCount}</td>
                        <td className="px-3 py-2">
                          <select
                            value={duplicateRowActions[row.incoming.key] || 'useGlobal'}
                            onChange={(e) => {
                              const value = e.target.value as DuplicateRowAction;
                              setDuplicateRowActions(prev => ({ ...prev, [row.incoming.key]: value }));
                            }}
                            className="border rounded px-2 py-1 text-xs"
                          >
                            <option value="useGlobal">Use Global</option>
                            <option value="merge">Merge</option>
                            <option value="replace">Replace</option>
                            <option value="importNew">Import New</option>
                            <option value="skip">Skip</option>
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {duplicateReviewRows.length > 0 && (
            <div className="p-3 rounded-xl border border-slate-200 bg-white text-xs text-slate-600">
              Overrides apply only to listed duplicates; non-duplicates always import as new orders.
            </div>
          )}

          {duplicateReviewRows.length > 0 && (
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-xs">
              <div className="p-3 rounded-lg border bg-slate-50">Merge: <b>{duplicateActionSummary.merge}</b></div>
              <div className="p-3 rounded-lg border bg-slate-50">Replace: <b>{duplicateActionSummary.replace}</b></div>
              <div className="p-3 rounded-lg border bg-slate-50">Import New: <b>{duplicateActionSummary.importNew}</b></div>
              <div className="p-3 rounded-lg border bg-slate-50">Skip: <b>{duplicateActionSummary.skip}</b></div>
              <div className="p-3 rounded-lg border bg-slate-50">Cancel: <b>{duplicateActionSummary.cancel}</b></div>
            </div>
          )}

          <div className="p-3 rounded-xl border border-slate-200 bg-slate-50 text-sm">
            <p className="font-semibold text-slate-700 mb-2">Duplicate handling</p>
            <div className="space-y-2">
              {[
                { value: 'importAll', label: 'Import All (always create new orders)' },
                { value: 'merge', label: 'Merge (add only non-duplicate lines)' },
                { value: 'replace', label: 'Replace (delete old order/lines, import fresh)' },
                { value: 'cancel', label: 'Cancel when duplicates are detected' },
              ].map(option => (
                <label key={option.value} className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="duplicateChoice"
                    checked={duplicateChoice === option.value}
                    onChange={() => {
                      setDuplicateChoice(option.value as DuplicateChoice);
                      localStorage.setItem('import_duplicate_choice', option.value);
                    }}
                  />
                  {option.label}
                </label>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={continueFromDuplicateReview}
              disabled={duplicateActionSummary.cancel > 0}
              className="px-5 py-2 bg-blue-600 text-white rounded-lg font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Continue
            </button>
            <button onClick={reset} className="px-5 py-2 border rounded-lg font-semibold text-slate-600">Cancel</button>
          </div>

          {duplicateActionSummary.cancel > 0 && (
            <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              Continue is disabled because one or more duplicate rows are set to Cancel. Change the row/global action to proceed.
            </div>
          )}
        </div>
      )}

      {step === 6 && parseResult && (
        <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-4">
          <h3 className="text-xl font-bold text-slate-800">Confirm Import</h3>

          {parseResult.warnings.length > 0 && (
            <div className="p-3 rounded-xl border border-amber-200 bg-amber-50 text-amber-800 text-sm">
              <p className="font-semibold mb-2">Warnings ({parseResult.warnings.length})</p>
              <ul className="list-disc list-inside max-h-32 overflow-auto">
                {parseResult.warnings.slice(0, 10).map((warning, index) => <li key={index}>{warning}</li>)}
              </ul>
            </div>
          )}

          {parseResult.errors.length > 0 && (
            <div className="p-3 rounded-xl border border-red-200 bg-red-50 text-red-700 text-sm">
              <p className="font-semibold mb-2">Errors ({parseResult.errors.length})</p>
              <ul className="list-disc list-inside max-h-32 overflow-auto">
                {parseResult.errors.slice(0, 10).map((error, index) => <li key={index}>{error}</li>)}
              </ul>
            </div>
          )}

          <div className="p-3 rounded-xl border border-slate-200 bg-slate-50 text-sm">
            <p className="font-semibold text-slate-700 mb-2">Duplicate handling</p>
            <div className="space-y-2">
              {[
                { value: 'importAll', label: 'Import All (default)' },
                { value: 'merge', label: 'Merge Into Existing Order' },
                { value: 'replace', label: 'Replace Existing Order' },
                { value: 'cancel', label: 'Cancel when duplicates are detected' },
              ].map(option => (
                <label key={option.value} className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="duplicateChoice"
                    checked={duplicateChoice === option.value}
                    onChange={() => {
                      setDuplicateChoice(option.value as DuplicateChoice);
                      localStorage.setItem('import_duplicate_choice', option.value);
                    }}
                  />
                  {option.label}
                </label>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => void executeImport()}
              disabled={busy}
              className="px-5 py-2 bg-green-600 text-white rounded-lg font-semibold disabled:opacity-50"
            >
              {busy ? 'Importing...' : 'Import'}
            </button>
            <button onClick={reset} className="px-5 py-2 border rounded-lg font-semibold text-slate-600">Cancel</button>
          </div>

          {importSummary && (
            <div className="p-4 rounded-xl border border-green-200 bg-green-50 text-green-700 text-sm flex items-center">
              <CheckCircle size={16} className="mr-2" />
              Imported {importSummary.ordersCreated} orders and {importSummary.linesCreated} lines (duplicates matched: {importSummary.duplicates}).
            </div>
          )}
        </div>
      )}

      <div className="flex justify-end">
        <button onClick={reset} className="text-sm text-slate-500 hover:text-slate-700 flex items-center"><X size={14} className="mr-1" /> Reset Wizard</button>
      </div>
    </div>
  );
};

export default ImportWizard;
