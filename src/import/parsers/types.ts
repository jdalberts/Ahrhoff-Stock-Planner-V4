import { ParseResult } from '../../../types';

export type SupportedFormat = 'inventoryLotsTemplate' | 'quickbooksSalesDetail' | 'genericTable' | 'unknown';

export interface WorkbookSheet {
  name: string;
  rows: any[][];
}

export interface WorkbookParseResult {
  fileName: string;
  fileSize: number;
  sheets: WorkbookSheet[];
}

export interface FormatDetectionResult {
  format: SupportedFormat;
  confidence: number;
  reason: string;
  headerRowIndex: number;
  columnMap: Record<string, number>;
}

export interface ParserContext {
  fileName: string;
  sheetName: string;
  debug?: boolean;
}

export interface ParseByFormatResult extends ParseResult {}
