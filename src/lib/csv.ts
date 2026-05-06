/** Minimal RFC-style CSV parser (quoted fields, commas). */

export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let inQuotes = false;
  const s = text.replace(/^\uFEFF/, "").trimEnd();

  for (let i = 0; i < s.length; i++) {
    const c = s[i];

    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
      continue;
    }

    if (c === '"') {
      inQuotes = true;
      continue;
    }
    if (c === ",") {
      row.push(cur);
      cur = "";
      continue;
    }
    if (c === "\n") {
      row.push(cur);
      cur = "";
      if (row.some((cell) => cell.trim() !== "")) {
        rows.push(row);
      }
      row = [];
      continue;
    }
    if (c === "\r") continue;
    cur += c;
  }

  row.push(cur);
  if (row.some((cell) => cell.trim() !== "")) {
    rows.push(row);
  }

  return rows;
}

export function csvRowsToRecords(header: string[], dataRows: string[][]): Record<string, string>[] {
  const h = header.map((x) => x.trim());
  return dataRows.map((cells) => {
    const rec: Record<string, string> = {};
    for (let i = 0; i < h.length; i++) {
      if (!h[i]) continue;
      rec[h[i]] = (cells[i] ?? "").trim();
    }
    return rec;
  });
}

/** Escape one CSV cell (RFC-style quoting when needed). */
export function escapeCsvField(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = typeof value === "string" ? value : String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function rowsToCsv(
  headers: string[],
  rows: (string | number | boolean | null | undefined)[][],
): string {
  const lines = [
    headers.map((h) => escapeCsvField(h)).join(","),
    ...rows.map((row) => row.map((cell) => escapeCsvField(cell)).join(",")),
  ];
  return lines.join("\n");
}
