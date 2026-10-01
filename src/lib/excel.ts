// SheetJS is heavy (~400 kB) and only needed for Excel I/O — load it on demand.
export interface RawRow {
  vin: string
  model: string
  color: string
  trailer?: number
  variant?: string
  lot?: string
}

const norm = (k: string) => k.toLowerCase().replace(/[\s._\-#]/g, '')

function pick(row: Record<string, any>, keys: string[]): any {
  for (const k of Object.keys(row)) {
    if (keys.includes(norm(k))) return row[k]
  }
  return undefined
}

export async function parseExcel(file: File): Promise<RawRow[]> {
  const XLSX = await import('xlsx')
  const buf = await file.arrayBuffer()
  const wb = XLSX.read(buf, { type: 'array' })
  const ws = wb.Sheets[wb.SheetNames[0]]
  const json = XLSX.utils.sheet_to_json<Record<string, any>>(ws, { defval: '' })
  const rows: RawRow[] = []
  for (const r of json) {
    const vin = String(pick(r, ['vin', 'vinno', 'vinnumber', 'เลขvin', 'chassis', 'chassisno']) ?? '')
      .trim()
      .toUpperCase()
    if (!vin || vin.length < 6) continue
    const model = String(pick(r, ['model', 'รุ่น', 'modelname', 'modeldesc']) ?? '').trim()
    const color = String(pick(r, ['color', 'สี', 'colour', 'exteriorcolor', 'paint']) ?? '').trim()
    const trailerRaw = pick(r, ['trailer', 'หาง', 'group', 'grouping', 'trailerno', 'truck'])
    const trailer =
      trailerRaw !== undefined && String(trailerRaw).trim() !== ''
        ? Number(String(trailerRaw).replace(/\D/g, '')) || undefined
        : undefined
    const variant = String(pick(r, ['variant', 'version', 'grade', 'trim', 'spec']) ?? '').trim() || undefined
    const lot = String(pick(r, ['lot', 'lotno', 'batch']) ?? '').trim() || undefined
    rows.push({ vin, model, color, trailer, variant, lot })
  }
  return rows
}

export function exportCsv(filename: string, headers: string[], rows: (string | number)[][]) {
  const esc = (v: any) => {
    const s = String(v ?? '')
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const csv = [headers.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))].join('\n')
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

// Vin list transfer (Yard to Yard) template — matches the operational Excel.
export async function downloadTemplate() {
  const XLSX = await import('xlsx')
  const headers = [
    'No', 'Lot transfer', 'moving date', 'From', 'To', 'Vin', 'Model name', 'Motor no.',
    'Engine No.', 'Model Code', 'Model', 'Color', 'battery', 'company', 'Location', 'Remark', 'Group',
  ]
  const ws = XLSX.utils.aoa_to_sheet([
    headers,
    [1, 'YT-2506-01', '23-Jun-25', 'A5', 'C0', 'LGXCE4CB0TG025160', 'BYD ATTO 3', 'M1234567', 'E1234567', 'ATTO3-EXT', 'ATTO 3', 'White', '60.48 kWh', 'Auto', 'A5', '', 'BL-2025-001'],
    [2, 'YT-2506-01', '23-Jun-25', 'A5', 'C0', 'LGXC74CB1TG010044', 'BYD DOLPHIN', 'M2234567', 'E2234567', 'DOL-EXT', 'DOLPHIN', 'Blue', '44.9 kWh', 'Auto', 'A5', '', 'BL-2025-001'],
    [3, 'YT-2506-02', '24-Jun-25', 'C0', 'A1', 'LGXCD4CB2TG044190', 'BYD SEAL', 'M3234567', 'E3234567', 'SEAL-PERF', 'SEAL', 'Black', '82.5 kWh', 'Auto', 'C0', 'rework', 'BL-2025-002'],
  ])
  ws['!cols'] = headers.map((h) => ({ wch: Math.max(10, h.length + 4) }))
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Tracking Status')
  XLSX.writeFile(wb, 'SJWD_Vin_Transfer_Template.xlsx')
}

/**
 * "Vin List Inventory" (Pre Gate-in) template — ONE SHEET PER YARD, matching
 * parseVinListInventory's expectations (excelTracking.ts): the sheet NAME is
 * what tags each row's yard (sheet names below match VINLIST_SHEETS exactly,
 * once normalized), and the header row needs at minimum a "Vin No." column —
 * "Gate In Date" lets the import screen's date filter work, "Gate Out Date"
 * marks a car that already left (merged into its existing VIN, not re-added).
 */
export async function downloadVinListTemplate() {
  const XLSX = await import('xlsx')
  const headers = ['No', 'Vin No.', 'Model', 'Color', 'Gate In Date', 'Gate Out Date', 'Remark']
  const sheet = (yard: string, rows: (string | number)[][]) => {
    const ws = XLSX.utils.aoa_to_sheet([headers, ...rows])
    ws['!cols'] = headers.map((h) => ({ wch: Math.max(10, h.length + 4) }))
    return { name: yard, ws }
  }
  const sheets = [
    sheet('VinListMasterRayong', [
      [1, 'LGXCE4CB0TG025160', 'BYD ATTO 3', 'White', '23-Jun-25', '', ''],
      [2, 'LGXC74CB1TG010044', 'BYD DOLPHIN', 'Blue', '23-Jun-25', '', ''],
    ]),
    sheet('SOI 5', [[1, 'LGXCD4CB2TG044190', 'BYD SEAL', 'Black', '24-Jun-25', '', '']]),
    sheet('NYB2', [[1, 'LGXCE4CB3TG055201', 'BYD ATTO 1', 'Grey', '24-Jun-25', '', '']]),
    sheet('20 Rai', [[1, 'LGXCE4CB4TG066312', 'BYD SEALION 7', 'White', '25-Jun-25', '', '']]),
    sheet('38 Rai', [[1, 'LGXCE4CB5TG077423', 'BYD M6', 'Silver', '25-Jun-25', '', '']]),
  ]
  const wb = XLSX.utils.book_new()
  for (const { name, ws } of sheets) XLSX.utils.book_append_sheet(wb, ws, name)
  XLSX.writeFile(wb, 'SJWD_Vin_List_Inventory_Template.xlsx')
}
