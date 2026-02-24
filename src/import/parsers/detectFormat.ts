import { FormatDetectionResult } from './types';

function normalized(value: any): string {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function findHeader(rows: any[][], requiredHeaders: string[], maxRows = 50): { headerRowIndex: number; columnMap: Record<string, number> } {
  for (let rowIndex = 0; rowIndex < Math.min(rows.length, maxRows); rowIndex++) {
    const row = rows[rowIndex] || [];
    const normalizedRow = row.map(normalized);
    const columnMap: Record<string, number> = {};

    for (const header of requiredHeaders) {
      const idx = normalizedRow.findIndex(cell => cell.includes(header));
      if (idx >= 0) columnMap[header] = idx;
    }

    if (requiredHeaders.every(header => columnMap[header] !== undefined)) {
      return { headerRowIndex: rowIndex, columnMap };
    }
  }

  return { headerRowIndex: -1, columnMap: {} };
}

export function detectFormat(rows: any[][]): FormatDetectionResult {
  const qbHeaders = ['transaction date', 'customer full name'];
  const qb = findHeader(rows, qbHeaders);
  if (qb.headerRowIndex >= 0) {
    return {
      format: 'quickbooksSalesDetail',
      confidence: 92,
      reason: 'Header row with "Transaction date" and "Customer full name" found',
      headerRowIndex: qb.headerRowIndex,
      columnMap: qb.columnMap,
    };
  }

  const invHeaders = ['product/service', 'qty on hand'];
  const inv = findHeader(rows, invHeaders);
  if (inv.headerRowIndex >= 0) {
    return {
      format: 'inventoryLotsTemplate',
      confidence: 88,
      reason: 'Header row with "Product/Service" and "Qty on Hand" found',
      headerRowIndex: inv.headerRowIndex,
      columnMap: inv.columnMap,
    };
  }

  const hasDenseRows = rows.slice(0, 20).some(row => (row || []).filter(cell => normalized(cell) !== '').length >= 3);
  if (hasDenseRows) {
    return {
      format: 'genericTable',
      confidence: 60,
      reason: 'No known template headers found; dense tabular data detected',
      headerRowIndex: 0,
      columnMap: {},
    };
  }

  return {
    format: 'unknown',
    confidence: 20,
    reason: 'Could not detect a supported format',
    headerRowIndex: -1,
    columnMap: {},
  };
}
