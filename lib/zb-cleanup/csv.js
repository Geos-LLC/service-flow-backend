'use strict';

// Minimal RFC 4180 CSV emitter. No external dependency.
// CRLF line endings. UTF-8 with BOM (Excel-friendly on Windows).

const UTF8_BOM = '﻿';

function escapeCell(value) {
  if (value === null || value === undefined) return '';
  let s;
  if (Array.isArray(value)) {
    // ;-delimited list within the cell
    s = value
      .filter((v) => v !== null && v !== undefined)
      .map((v) => String(v))
      .join(';');
  } else if (typeof value === 'object') {
    s = JSON.stringify(value);
  } else {
    s = String(value);
  }
  // Quote if cell contains comma, quote, CR, or LF
  if (/[",\r\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function rowsToCsv(rows, columns) {
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new Error('rowsToCsv: columns array required');
  }
  const header = columns.map(escapeCell).join(',') + '\r\n';
  const body = (rows || [])
    .map((row) => columns.map((col) => escapeCell(row[col])).join(','))
    .join('\r\n');
  // Trailing CRLF on the last data row keeps Excel happy.
  const tail = rows && rows.length ? '\r\n' : '';
  return UTF8_BOM + header + body + tail;
}

module.exports = { rowsToCsv, escapeCell };
