import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle, FileSpreadsheet, Search, Upload, X } from 'lucide-react';
import { db } from './db';
import { CustomerV5, ImportBatchV5, InventoryLot, Item, NormalizedTransaction, OrderLineV5, OrderV5, ParseResult, ProductV5 } from './types';
import { detectFormat, parseByFormat, parseWorkbook, WorkbookParseResult } from './src/import/parsers';
import { normalizeProductName, parsePackInfo } from './productNormalization';

type Step = 1 | 2 | 3 | 4 | 5 | 6;
type ParseMode = 'sales' | 'stock';
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

interface InvoiceSelectionGroup {
  key: string;
  invoice: string;
  customerName: string;
  date: string;
  totalRows: number;
  selectedRows: number;
  indices: number[];
}

interface StockPreviewRow {
  id: string;
  rowNumber: number;
  productName: string;
  qtyOnHand: number;
  skip: boolean;
}

interface Props {
  onImported?: () => Promise<void> | void;
}

const uid = (): string => Date.now().toString(36) + Math.random().toString(36).slice(2, 9);

const normalizeText = (value: string): string => value.toLowerCase().replace(/\s+/g, ' ').trim();

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
  const [parseMode, setParseMode] = useState<ParseMode>('sales');
  const [parseResult, setParseResult] = useState<ParseResult | null>(null);
  const [stockPreviewRows, setStockPreviewRows] = useState<StockPreviewRow[]>([]);
  const [debugMode, setDebugMode] = useState<boolean>(() => localStorage.getItem('import_debug_mode') === '1');
  const [busy, setBusy] = useState(false);
  const [fatalError, setFatalError] = useState('');
  const [duplicateChoice, setDuplicateChoice] = useState<DuplicateChoice>(() => {
    const saved = localStorage.getItem('import_duplicate_choice') as DuplicateChoice | null;
    return saved || 'importAll';
  });
  const [excludedRowIndexes, setExcludedRowIndexes] = useState<Set<number>>(new Set());
  const [selectedInvoiceGroupKey, setSelectedInvoiceGroupKey] = useState('');
  const [previewSearchTerm, setPreviewSearchTerm] = useState('');
  const [importSummary, setImportSummary] = useState<{ ordersCreated: number; linesCreated: number; duplicates: number } | null>(null);
  const [stockImportSummary, setStockImportSummary] = useState<{ rowsApplied: number; lotsCreated: number; itemsCreated: number } | null>(null);
  const [duplicateReviewRows, setDuplicateReviewRows] = useState<DuplicateReviewRow[]>([]);
  const [duplicateRowActions, setDuplicateRowActions] = useState<Record<string, DuplicateRowAction>>({});

  const sheetRows = workbook?.sheets[selectedSheet]?.rows || [];
  const detection = useMemo(() => detectFormat(sheetRows), [sheetRows]);

  const selectedTransactions = useMemo(() => {
    if (!parseResult) return [];
    return parseResult.transactions.filter((_, index) => !excludedRowIndexes.has(index));
  }, [parseResult, excludedRowIndexes]);

  const parsedPreview = useMemo(() => {
    return selectedTransactions.slice(0, 50);
  }, [selectedTransactions]);

  const deselectedPreviewRows = useMemo(() => {
    if (!parseResult) return [] as Array<{ rowNumber: number; customerName: string; transactionDate: string; productService: string }>;

    const rows: Array<{ rowNumber: number; customerName: string; transactionDate: string; productService: string }> = [];
    for (let index = 0; index < parseResult.transactions.length; index++) {
      if (!excludedRowIndexes.has(index)) continue;
      const tx = parseResult.transactions[index];
      rows.push({
        rowNumber: index + 1,
        customerName: tx.customerName,
        transactionDate: tx.transactionDate,
        productService: tx.productService,
      });
      if (rows.length >= 10) break;
    }
    return rows;
  }, [parseResult, excludedRowIndexes]);

  const previewStats = useMemo(() => {
    if (!parseResult) return { totalRows: 0, ordersDetected: 0, customersDetected: 0 };
    const grouped = aggregateOrders(selectedTransactions);
    return {
      totalRows: selectedTransactions.length,
      ordersDetected: grouped.length,
      customersDetected: new Set(selectedTransactions.map(tx => normalizeText(tx.customerName))).size,
    };
  }, [parseResult, selectedTransactions]);

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

  const selectedStockRows = useMemo(() => {
    return stockPreviewRows.filter(row => !row.skip);
  }, [stockPreviewRows]);

  const previewRowsForTable = useMemo(() => {
    if (!parseResult) return [] as Array<{ row: NormalizedTransaction; index: number }>;

    const needle = normalizeText(previewSearchTerm);
    const source = parseResult.transactions.map((row, index) => ({ row, index }));
    const filtered = !needle
      ? source
      : source.filter(({ row }) => {
          const haystack = [row.customerName, row.number, row.productService, row.transactionDate]
            .map(value => normalizeText(value || ''))
            .join(' ');
          return haystack.includes(needle);
        });

    return filtered.slice(0, 50);
  }, [parseResult, previewSearchTerm]);

  const invoiceSelectionGroups = useMemo(() => {
    if (!parseResult) return [] as InvoiceSelectionGroup[];

    const grouped = new Map<string, InvoiceSelectionGroup>();
    for (let index = 0; index < parseResult.transactions.length; index++) {
      const tx = parseResult.transactions[index];
      const invoice = tx.number || 'No invoice';
      const customerName = tx.customerName || 'Unknown customer';
      const date = tx.transactionDate || 'No date';
      const key = `${invoice}|${customerName}|${date}`;

      if (!grouped.has(key)) {
        grouped.set(key, {
          key,
          invoice,
          customerName,
          date,
          totalRows: 0,
          selectedRows: 0,
          indices: [],
        });
      }

      const group = grouped.get(key)!;
      group.totalRows += 1;
      group.selectedRows += excludedRowIndexes.has(index) ? 0 : 1;
      group.indices.push(index);
    }

    return [...grouped.values()].sort((a, b) => {
      if (a.date !== b.date) return b.date.localeCompare(a.date);
      return a.invoice.localeCompare(b.invoice);
    });
  }, [parseResult, excludedRowIndexes]);

  const selectedInvoiceGroup = useMemo(() => {
    if (!selectedInvoiceGroupKey) return null;
    return invoiceSelectionGroups.find(group => group.key === selectedInvoiceGroupKey) || null;
  }, [invoiceSelectionGroups, selectedInvoiceGroupKey]);

  const selectedInvoiceLines = useMemo(() => {
    if (!parseResult || !selectedInvoiceGroup) return [] as Array<{ row: NormalizedTransaction; index: number }>;
    return selectedInvoiceGroup.indices.map(index => ({ row: parseResult.transactions[index], index }));
  }, [parseResult, selectedInvoiceGroup]);

  useEffect(() => {
    if (invoiceSelectionGroups.length === 0) {
      if (selectedInvoiceGroupKey) setSelectedInvoiceGroupKey('');
      return;
    }

    if (!invoiceSelectionGroups.some(group => group.key === selectedInvoiceGroupKey)) {
      setSelectedInvoiceGroupKey(invoiceSelectionGroups[0].key);
    }
  }, [invoiceSelectionGroups, selectedInvoiceGroupKey]);

  const reset = () => {
    setStep(1);
    setFile(null);
    setWorkbook(null);
    setSelectedSheet(0);
    setParseMode('sales');
    setParseResult(null);
    setStockPreviewRows([]);
    setExcludedRowIndexes(new Set());
    setSelectedInvoiceGroupKey('');
    setPreviewSearchTerm('');
    setFatalError('');
    setImportSummary(null);
    setStockImportSummary(null);
    setDuplicateReviewRows([]);
    setDuplicateRowActions({});
  };

  const handleFile = async (selected: File) => {
    setBusy(true);
    setFatalError('');
    setParseMode('sales');
    setParseResult(null);
    setStockPreviewRows([]);
    setExcludedRowIndexes(new Set());
    setSelectedInvoiceGroupKey('');
    setPreviewSearchTerm('');
    setImportSummary(null);
    setStockImportSummary(null);

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

    if (detection.format === 'inventoryLotsTemplate') {
      const headerRow = sheet.rows[detection.headerRowIndex] || [];
      const headers = headerRow.map(cell => String(cell || '').toLowerCase().trim());
      const productCol = headers.findIndex(header => header.includes('product/service') || header.includes('product') || header.includes('service'));
      const qtyCol = headers.findIndex(header => header.includes('qty on hand') || header.includes('quantity on hand') || header.includes('qty'));

      const rows: StockPreviewRow[] = [];
      for (let rowIndex = detection.headerRowIndex + 1; rowIndex < sheet.rows.length; rowIndex++) {
        const row = sheet.rows[rowIndex] || [];
        const productName = String(row[productCol >= 0 ? productCol : 0] || '').trim();
        if (!productName) continue;
        if (productName.toUpperCase() === 'TOTAL') break;

        rows.push({
          id: `${rowIndex}_${productName}`,
          rowNumber: rowIndex + 1,
          productName,
          qtyOnHand: Math.max(0, toNumber(row[qtyCol >= 0 ? qtyCol : 4])),
          skip: false,
        });
      }

      if (rows.length === 0) {
        setFatalError('No stock rows found below the stocktake header row.');
        return;
      }

      if (debugMode) {
        console.log('[import] format detection', detection);
        console.log('[import] parsed stock rows', rows.length);
      }

      setParseMode('stock');
      setParseResult(null);
      setStockPreviewRows(rows);
      setSelectedInvoiceGroupKey('');
      setPreviewSearchTerm('');
      setStockImportSummary(null);
      setStep(4);
      return;
    }

    const result = parseByFormat(sheet.rows, detection.format, {
      fileName: workbook.fileName,
      sheetName: sheet.name,
      debug: debugMode,
    });

    if (debugMode) {
      console.log('[import] format detection', detection);
      console.log('[import] parsed transactions', result.transactions.length);
    }

    setParseMode('sales');
    setParseResult(result);
    setStockPreviewRows([]);
    setExcludedRowIndexes(new Set());
    setSelectedInvoiceGroupKey('');
    setPreviewSearchTerm('');
    setStockImportSummary(null);
    setStep(4);
  };

  const selectSelectedInvoiceRows = () => {
    if (!selectedInvoiceGroup) return;
    setExcludedRowIndexes(prev => {
      const next = new Set(prev);
      for (const rowIndex of selectedInvoiceGroup.indices) {
        next.delete(rowIndex);
      }
      return next;
    });
  };

  const deselectSelectedInvoiceRows = () => {
    if (!selectedInvoiceGroup) return;
    setExcludedRowIndexes(prev => {
      const next = new Set(prev);
      for (const rowIndex of selectedInvoiceGroup.indices) {
        next.add(rowIndex);
      }
      return next;
    });
  };

  const toggleStockPreviewRow = (rowId: string) => {
    setStockPreviewRows(prev => prev.map(row => row.id === rowId ? { ...row, skip: !row.skip } : row));
  };

  const selectAllStockRows = () => {
    setStockPreviewRows(prev => prev.map(row => ({ ...row, skip: false })));
  };

  const deselectAllStockRows = () => {
    setStockPreviewRows(prev => prev.map(row => ({ ...row, skip: true })));
  };

  const togglePreviewRow = (index: number) => {
    setExcludedRowIndexes(prev => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  const selectAllPreviewRows = () => {
    setExcludedRowIndexes(new Set());
  };

  const deselectAllPreviewRows = () => {
    if (!parseResult) return;
    const next = new Set<number>();
    for (let i = 0; i < parseResult.transactions.length; i++) {
      next.add(i);
    }
    setExcludedRowIndexes(next);
  };

  const continueToConfirm = () => {
    if (parseMode === 'stock') {
      if (selectedStockRows.length === 0) {
        setFatalError('Select at least one stock row to continue.');
        return;
      }
      setFatalError('');
      setStep(6);
      return;
    }

    if (!parseResult) return;
    if (selectedTransactions.length === 0) {
      setFatalError('Select at least one preview row to continue.');
      return;
    }

    setFatalError('');

    void (async () => {
      const groupedOrders = aggregateOrders(selectedTransactions);
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

  const executeStockImport = async () => {
    if (!workbook) return;
    if (selectedStockRows.length === 0) {
      setFatalError('Select at least one stock row to import.');
      return;
    }

    setBusy(true);
    setFatalError('');

    try {
      const existingLots = await db.getAll<InventoryLot>('lots');
      const existingItems = await db.getAll<Item>('items');
      const itemByName = new Map(existingItems.map(item => [normalizeText(item.name), item]));
      const now = new Date().toISOString();
      const today = now.split('T')[0];

      let itemsCreated = 0;
      let lotsCreated = 0;

      for (const row of selectedStockRows) {
        const itemKey = normalizeText(row.productName);
        let item = itemByName.get(itemKey);

        if (!item) {
          item = {
            id: uid(),
            skuCode: `AUTO-${row.productName.replace(/[^a-zA-Z0-9]+/g, '-').toUpperCase().slice(0, 24)}`,
            name: row.productName,
            category: 'Other',
            packSize: 1,
            leadTimeDays: 14,
            moq: 0,
            costPerUnit: 0,
          };
          await db.put('items', item);
          itemByName.set(itemKey, item);
          itemsCreated += 1;
        }

        const activeLots = existingLots.filter(lot => lot.itemId === item!.id && lot.status === 'available');
        for (const lot of activeLots) {
          await db.put('lots', { ...lot, quantityRemaining: 0 });
        }

        if (row.qtyOnHand > 0) {
          const newLot: InventoryLot = {
            id: uid(),
            itemId: item.id,
            lotNumber: `STOCKTAKE-${today}-${uid().slice(-4).toUpperCase()}`,
            expiryDate: null,
            quantityRemaining: row.qtyOnHand,
            receivedDate: today,
            quantityReceived: row.qtyOnHand,
            status: 'available',
            notes: `Imported from stocktake worksheet: ${workbook.fileName}`,
          };
          await db.put('lots', newLot);
          lotsCreated += 1;
        }
      }

      const batch: ImportBatchV5 = {
        id: uid(),
        fileName: workbook.fileName,
        sheetName: workbook.sheets[selectedSheet].name,
        formatDetected: 'inventoryLotsTemplate',
        confidence: detection.confidence,
        rowCountRaw: selectedStockRows.length,
        ordersCreated: 0,
        linesCreated: lotsCreated,
        warnings: [],
        createdAt: now,
      };
      await db.put('import_batches', batch);

      setStockImportSummary({ rowsApplied: selectedStockRows.length, lotsCreated, itemsCreated });
      if (onImported) await onImported();
    } catch (err: any) {
      setFatalError(err?.message || 'Stock import failed.');
    } finally {
      setBusy(false);
    }
  };

  const executeImport = async () => {
    if (!parseResult || !workbook) return;
    if (selectedTransactions.length === 0) {
      setFatalError('Select at least one preview row to import.');
      return;
    }

    setBusy(true);
    setFatalError('');

    try {
      const validRows: NormalizedTransaction[] = [];
      const warnings = [...parseResult.warnings];

      for (const tx of selectedTransactions) {
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
    const rows = selectedTransactions.map(tx => [
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

      <div className="p-3 rounded-xl border border-blue-200 bg-blue-50 text-blue-800 text-sm">
        <p><b>What to upload where:</b></p>
        <p>• <b>Stock Take tab</b>: Xero Stocktake Worksheet (best for current stock on hand updates).</p>
        <p>• <b>Import Wizard</b>: Sales/order transaction files. Stocktake worksheets are also supported here.</p>
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

      {step === 4 && parseMode === 'sales' && parseResult && (
        <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-xl font-bold text-slate-800">Preview (first 50 rows)</h3>
            <button onClick={exportPreviewCsv} className="px-3 py-2 text-xs border rounded-lg text-slate-600">Export Preview CSV</button>
          </div>

          <div className="flex items-center gap-2 text-xs">
            <button onClick={selectAllPreviewRows} className="px-3 py-1.5 border rounded-lg text-slate-600">Select all</button>
            <button onClick={deselectAllPreviewRows} className="px-3 py-1.5 border rounded-lg text-slate-600">Deselect all</button>
            <span className="text-slate-500">Selected for upload: <b>{selectedTransactions.length}</b> / {parseResult.transactions.length}</span>
          </div>

          {invoiceSelectionGroups.length > 0 && (
            <div className="p-3 rounded-xl border border-slate-200 bg-slate-50">
              <p className="text-xs text-slate-600 mb-2">Invoice selection</p>
              <div className="flex flex-col md:flex-row md:items-center gap-2">
                <select
                  className="border rounded-lg px-3 py-2 text-sm bg-white md:min-w-[420px]"
                  value={selectedInvoiceGroupKey}
                  onChange={(event) => setSelectedInvoiceGroupKey(event.target.value)}
                >
                  {invoiceSelectionGroups.map(group => (
                    <option key={group.key} value={group.key}>
                      {group.invoice} • {group.customerName} • {group.date} ({group.selectedRows}/{group.totalRows} selected)
                    </option>
                  ))}
                </select>
                <button
                  onClick={selectSelectedInvoiceRows}
                  disabled={!selectedInvoiceGroup}
                  className="px-3 py-2 border rounded-lg text-xs text-slate-600 bg-white disabled:opacity-50"
                >
                  Select invoice
                </button>
                <button
                  onClick={deselectSelectedInvoiceRows}
                  disabled={!selectedInvoiceGroup}
                  className="px-3 py-2 border rounded-lg text-xs text-slate-600 bg-white disabled:opacity-50"
                >
                  Deselect invoice
                </button>
              </div>

              {selectedInvoiceGroup && selectedInvoiceLines.length > 0 && (
                <div className="mt-3 border rounded-xl bg-white overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-slate-50">
                      <tr>
                        {['Select', 'Product', 'Qty', 'Amount'].map(header => (
                          <th key={header} className="text-left px-3 py-2 uppercase text-slate-500">{header}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {selectedInvoiceLines.map(({ row, index }) => {
                        const isSelected = !excludedRowIndexes.has(index);
                        return (
                          <tr
                            key={`invoice-line-${index}`}
                            className={`border-t cursor-pointer ${isSelected ? '' : 'bg-slate-100 text-slate-400 line-through'}`}
                            onClick={() => togglePreviewRow(index)}
                          >
                            <td className="px-3 py-2">
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onClick={(event) => event.stopPropagation()}
                                onChange={() => togglePreviewRow(index)}
                              />
                            </td>
                            <td className="px-3 py-2">{row.productService || '—'}</td>
                            <td className="px-3 py-2">{row.quantity}</td>
                            <td className="px-3 py-2">{row.amount}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          <div className="relative">
            <Search size={14} className="absolute left-3 top-3 text-slate-400" />
            <input
              value={previewSearchTerm}
              onChange={(event) => setPreviewSearchTerm(event.target.value)}
              placeholder="Search product, customer, invoice, or date"
              className="w-full pl-9 pr-3 py-2 border rounded-lg text-sm"
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
            <div className="p-3 rounded-lg border bg-slate-50">Rows selected: <b>{previewStats.totalRows}</b></div>
            <div className="p-3 rounded-lg border bg-slate-50">Orders detected: <b>{previewStats.ordersDetected}</b></div>
            <div className="p-3 rounded-lg border bg-slate-50">Customers detected: <b>{previewStats.customersDetected}</b></div>
          </div>

          <div className="overflow-x-auto border rounded-xl">
            <table className="w-full text-sm">
              <thead className="bg-slate-50">
                <tr>
                  {['Select', 'Customer', 'Date', 'Invoice', 'Product', 'Quantity', 'Amount'].map(header => (
                    <th key={header} className="text-left px-3 py-2 text-xs uppercase text-slate-500">{header}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {previewRowsForTable.map(({ row, index }) => {
                  const isSelected = !excludedRowIndexes.has(index);
                  return (
                  <tr
                    key={`preview-row-${index}`}
                    className={`border-t cursor-pointer ${isSelected ? 'bg-white' : 'bg-slate-100 text-slate-400 line-through'}`}
                    onClick={() => togglePreviewRow(index)}
                  >
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => togglePreviewRow(index)}
                        onClick={(event) => event.stopPropagation()}
                      />
                    </td>
                    <td className="px-3 py-2">{row.customerName}</td>
                    <td className="px-3 py-2">{row.transactionDate}</td>
                    <td className="px-3 py-2">{row.number}</td>
                    <td className="px-3 py-2">{row.productService}</td>
                    <td className="px-3 py-2">{row.quantity}</td>
                    <td className="px-3 py-2">{row.amount}</td>
                  </tr>
                  );
                })}
                {previewRowsForTable.length === 0 && (
                  <tr className="border-t">
                    <td colSpan={7} className="px-3 py-4 text-center text-slate-400">No rows match your search.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {excludedRowIndexes.size > 0 && (
            <div className="p-3 rounded-xl border border-amber-200 bg-amber-50 text-amber-800 text-sm">
              <p className="font-semibold mb-2">Deselected rows (not uploaded): {excludedRowIndexes.size}</p>
              <ul className="list-disc list-inside max-h-36 overflow-auto space-y-1">
                {deselectedPreviewRows.map((row) => (
                  <li key={row.rowNumber}>
                    Row {row.rowNumber}: {row.customerName || 'Unknown customer'} • {row.transactionDate || 'No date'} • {row.productService || 'No product'}
                  </li>
                ))}
              </ul>
              {excludedRowIndexes.size > deselectedPreviewRows.length && (
                <p className="text-xs mt-2 text-amber-700">Showing first {deselectedPreviewRows.length} deselected rows.</p>
              )}
            </div>
          )}

          <button
            onClick={continueToConfirm}
            disabled={selectedTransactions.length === 0}
            className="px-5 py-2 bg-blue-600 text-white rounded-lg font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Continue
          </button>
        </div>
      )}

      {step === 4 && parseMode === 'stock' && (
        <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-xl font-bold text-slate-800">Stocktake Preview</h3>
          </div>

          <div className="p-3 rounded-xl border border-blue-200 bg-blue-50 text-blue-800 text-xs">
            Upload type detected: <b>Stocktake Worksheet</b>. This will update current stock on hand.
          </div>

          <div className="flex items-center gap-2 text-xs">
            <button onClick={selectAllStockRows} className="px-3 py-1.5 border rounded-lg text-slate-600">Select all</button>
            <button onClick={deselectAllStockRows} className="px-3 py-1.5 border rounded-lg text-slate-600">Deselect all</button>
            <span className="text-slate-500">Selected for upload: <b>{selectedStockRows.length}</b> / {stockPreviewRows.length}</span>
          </div>

          <div className="overflow-x-auto border rounded-xl max-h-[420px]">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 sticky top-0">
                <tr>
                  {['Select', 'Row', 'Product', 'Qty on Hand'].map(header => (
                    <th key={header} className="text-left px-3 py-2 text-xs uppercase text-slate-500">{header}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {stockPreviewRows.map((row) => (
                  <tr
                    key={row.id}
                    className={`border-t cursor-pointer ${row.skip ? 'bg-slate-100 text-slate-400 line-through' : 'bg-white'}`}
                    onClick={() => toggleStockPreviewRow(row.id)}
                  >
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={!row.skip}
                        onChange={() => toggleStockPreviewRow(row.id)}
                        onClick={(event) => event.stopPropagation()}
                      />
                    </td>
                    <td className="px-3 py-2">{row.rowNumber}</td>
                    <td className="px-3 py-2">{row.productName}</td>
                    <td className="px-3 py-2">{row.qtyOnHand}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <button
            onClick={continueToConfirm}
            disabled={selectedStockRows.length === 0}
            className="px-5 py-2 bg-blue-600 text-white rounded-lg font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Continue
          </button>
        </div>
      )}

      {step === 5 && parseMode === 'sales' && parseResult && (
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

      {step === 6 && parseMode === 'sales' && parseResult && (
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

      {step === 6 && parseMode === 'stock' && (
        <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-4">
          <h3 className="text-xl font-bold text-slate-800">Confirm Stock Import</h3>

          <div className="p-3 rounded-xl border border-slate-200 bg-slate-50 text-sm">
            <p>Selected rows: <b>{selectedStockRows.length}</b></p>
            <p className="text-slate-600 mt-1">This applies the worksheet as a current stock snapshot by zeroing existing available lots per selected product and creating a new stocktake lot.</p>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => void executeStockImport()}
              disabled={busy || selectedStockRows.length === 0}
              className="px-5 py-2 bg-green-600 text-white rounded-lg font-semibold disabled:opacity-50"
            >
              {busy ? 'Importing...' : 'Import Stock Snapshot'}
            </button>
            <button onClick={reset} className="px-5 py-2 border rounded-lg font-semibold text-slate-600">Cancel</button>
          </div>

          {stockImportSummary && (
            <div className="p-4 rounded-xl border border-green-200 bg-green-50 text-green-700 text-sm flex items-center">
              <CheckCircle size={16} className="mr-2" />
              Applied {stockImportSummary.rowsApplied} stock rows, created {stockImportSummary.lotsCreated} lots, and created {stockImportSummary.itemsCreated} new items.
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
