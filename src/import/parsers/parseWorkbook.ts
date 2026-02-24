import { WorkbookParseResult } from './types';

declare global {
  interface Window {
    XLSX?: any;
  }
}

function parseCsv(text: string): any[][] {
  const rows: any[][] = [];
  const lines = text.split(/\r?\n/).filter(line => line.length > 0);

  for (const line of lines) {
    const cells: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let index = 0; index < line.length; index++) {
      const ch = line[index];
      const next = line[index + 1];

      if (ch === '"') {
        if (inQuotes && next === '"') {
          current += '"';
          index += 1;
        } else {
          inQuotes = !inQuotes;
        }
        continue;
      }

      if (ch === ',' && !inQuotes) {
        cells.push(current.trim());
        current = '';
        continue;
      }

      current += ch;
    }

    cells.push(current.trim());
    rows.push(cells);
  }

  return rows;
}

export async function parseWorkbook(file: File): Promise<WorkbookParseResult> {
  const lowerName = file.name.toLowerCase();

  if (lowerName.endsWith('.csv')) {
    const text = await file.text();
    return {
      fileName: file.name,
      fileSize: file.size,
      sheets: [{ name: 'CSV', rows: parseCsv(text) }],
    };
  }

  if (!window.XLSX) {
    throw new Error('XLSX parser not available. Please refresh and try again.');
  }

  const data = await file.arrayBuffer();
  const workbook = window.XLSX.read(data, { type: 'array' });

  const sheets = workbook.SheetNames.map((name: string) => {
    const sheet = workbook.Sheets[name];
    const rows = window.XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    return { name, rows };
  });

  return {
    fileName: file.name,
    fileSize: file.size,
    sheets,
  };
}
