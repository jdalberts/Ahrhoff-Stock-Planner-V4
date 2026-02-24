import { NormalizedTransaction } from '../../../types';
import { detectFormat } from './detectFormat';
import { FormatDetectionResult, ParseByFormatResult, ParserContext, SupportedFormat } from './types';

function toNumber(value: any): number {
  const text = String(value ?? '').trim();
  if (!text) return 0;

  const bracketNegative = /^\(.*\)$/.test(text);
  const cleaned = text
    .replace(/[R$,%\s]/g, '')
    .replace(/\((.*)\)/, '$1')
    .replace(/,/g, '');

  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) return 0;
  return bracketNegative ? -Math.abs(parsed) : parsed;
}

function toIsoDate(value: any): string {
  if (value === null || value === undefined || value === '') return '';

  if (typeof value === 'number' && Number.isFinite(value)) {
    const excelEpoch = new Date(Date.UTC(1899, 11, 30));
    const dt = new Date(excelEpoch.getTime() + value * 86400000);
    return dt.toISOString().split('T')[0];
  }

  const text = String(value).trim();

  const isoMatch = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (isoMatch) {
    const year = Number(isoMatch[1]);
    const month = Number(isoMatch[2]);
    const day = Number(isoMatch[3]);
    if (year >= 1900 && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${year.toString().padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  const slashOrDashMatch = text.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/);
  if (slashOrDashMatch) {
    const partA = Number(slashOrDashMatch[1]);
    const partB = Number(slashOrDashMatch[2]);
    const yearRaw = Number(slashOrDashMatch[3]);
    const year = yearRaw < 100 ? 2000 + yearRaw : yearRaw;

    let day = partA;
    let month = partB;

    if (partA <= 12 && partB > 12) {
      month = partA;
      day = partB;
    } else if (partA > 12 && partB <= 12) {
      day = partA;
      month = partB;
    } else {
      day = partA;
      month = partB;
    }

    if (year >= 1900 && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${year.toString().padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  const dt = new Date(text);
  if (!Number.isNaN(dt.getTime())) {
    return dt.toISOString().split('T')[0];
  }
  return '';
}

function safeCell(row: any[], index: number): any {
  if (index < 0) return '';
  return row[index] ?? '';
}

function colIndex(headers: string[], candidates: string[]): number {
  return headers.findIndex(header => candidates.some(candidate => header.includes(candidate)));
}

function normalize(value: any): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function parseQuickbooksSalesDetail(rows: any[][], detection: FormatDetectionResult, context: ParserContext): ParseByFormatResult {
  const warnings: string[] = [];
  const errors: string[] = [];
  const transactions: NormalizedTransaction[] = [];

  if (detection.headerRowIndex < 0) {
    return {
      transactions,
      metadata: {
        sourceFileName: context.fileName,
        sheetName: context.sheetName,
        formatDetected: 'quickbooksSalesDetail',
        confidence: detection.confidence,
      },
      warnings,
      errors: ['Could not locate QuickBooks detail header row.'],
    };
  }

  const headerRow = rows[detection.headerRowIndex] || [];
  const headers = headerRow.map(cell => normalize(cell).toLowerCase());

  const idxDate = colIndex(headers, ['transaction date', 'date']);
  const idxType = colIndex(headers, ['transaction type', 'type']);
  const idxNumber = colIndex(headers, ['number', 'num']);
  const idxCustomer = colIndex(headers, ['customer full name', 'customer', 'client']);
  const idxMemo = colIndex(headers, ['memo/description', 'memo', 'description']);
  const idxQty = colIndex(headers, ['quantity', 'qty']);
  const idxPrice = colIndex(headers, ['sales price', 'unit price', 'price']);
  const idxAmount = colIndex(headers, ['amount', 'total']);

  if (idxDate < 0 || idxCustomer < 0) {
    errors.push('Required columns missing: Transaction date and/or Customer full name.');
  }

  let currentProductService = '';

  for (let rowIndex = detection.headerRowIndex + 1; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex] || [];
    const firstColumn = normalize(row[0]);
    const dateText = normalize(safeCell(row, idxDate));

    if (!firstColumn && !dateText) continue;

    if (firstColumn.toLowerCase().startsWith('total for')) {
      continue;
    }

    const sectionHeaderCandidate = firstColumn && !dateText;
    if (sectionHeaderCandidate) {
      currentProductService = firstColumn;
      continue;
    }

    const transactionDate = toIsoDate(safeCell(row, idxDate));
    if (!transactionDate) {
      warnings.push(`Skipped row ${rowIndex + 1}: invalid or missing transaction date.`);
      continue;
    }

    const customerName = normalize(safeCell(row, idxCustomer));
    if (!customerName) {
      warnings.push(`Skipped row ${rowIndex + 1}: missing customer name.`);
      continue;
    }

    const tx: NormalizedTransaction = {
      customerName,
      transactionDate,
      transactionType: normalize(safeCell(row, idxType)),
      number: normalize(safeCell(row, idxNumber)),
      productService: currentProductService || normalize(safeCell(row, 0)),
      memo: normalize(safeCell(row, idxMemo)),
      quantity: toNumber(safeCell(row, idxQty)),
      unitPrice: toNumber(safeCell(row, idxPrice)),
      amount: toNumber(safeCell(row, idxAmount)),
    };

    if (!tx.productService) {
      warnings.push(`Row ${rowIndex + 1}: missing Product/Service section, using blank value.`);
    }

    transactions.push(tx);
  }

  return {
    transactions,
    metadata: {
      sourceFileName: context.fileName,
      sheetName: context.sheetName,
      formatDetected: 'quickbooksSalesDetail',
      confidence: detection.confidence,
    },
    warnings,
    errors,
  };
}

function parseGeneric(rows: any[][], detection: FormatDetectionResult, context: ParserContext, format: SupportedFormat): ParseByFormatResult {
  const warnings: string[] = ['Generic parser used. Please validate preview before import.'];
  const errors: string[] = [];
  const transactions: NormalizedTransaction[] = [];

  const startIndex = Math.max(detection.headerRowIndex + 1, 1);
  for (let rowIndex = startIndex; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex] || [];
    const customerName = normalize(row[1]);
    const transactionDate = toIsoDate(row[0]);
    const productService = normalize(row[2]);

    if (!customerName || !transactionDate) continue;

    transactions.push({
      customerName,
      transactionDate,
      transactionType: normalize(row[3]),
      number: normalize(row[4]),
      productService,
      memo: normalize(row[5]),
      quantity: toNumber(row[6]),
      unitPrice: toNumber(row[7]),
      amount: toNumber(row[8]),
    });
  }

  return {
    transactions,
    metadata: {
      sourceFileName: context.fileName,
      sheetName: context.sheetName,
      formatDetected: format,
      confidence: detection.confidence,
    },
    warnings,
    errors,
  };
}

export function parseByFormat(rows: any[][], format: SupportedFormat, context: ParserContext): ParseByFormatResult {
  const detection = detectFormat(rows);

  if (context.debug) {
    console.log('[import] format detection', detection);
    console.log('[import] header row index', detection.headerRowIndex);
  }

  if (format === 'quickbooksSalesDetail') {
    return parseQuickbooksSalesDetail(rows, detection, context);
  }

  if (format === 'inventoryLotsTemplate' || format === 'genericTable') {
    return parseGeneric(rows, detection, context, format);
  }

  return {
    transactions: [],
    metadata: {
      sourceFileName: context.fileName,
      sheetName: context.sheetName,
      formatDetected: 'unknown',
      confidence: 0,
    },
    warnings: [],
    errors: ['Unsupported format.'],
  };
}
