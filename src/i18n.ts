import type { Lang } from './types'

type Dict = Record<string, { th: string; en: string }>

const D: Dict = {
  appName: { th: 'SJWD Yard Control', en: 'SJWD Yard Control' },
  appSub: { th: 'ระบบบริหารลานจอดรถ', en: 'Vehicle Yard Management' },

  // nav
  dashboard: { th: 'ภาพรวม', en: 'Dashboard' },
  import: { th: 'นำเข้าข้อมูล', en: 'Import' },
  trailers: { th: 'หางเทรลเลอร์', en: 'Trailers' },
  report: { th: 'รายงาน', en: 'Report' },
  gatein: { th: 'Gate In/Out', en: 'Gate In/Out' },
  driver: { th: 'พนักงานขับรถ', en: 'Driver' },
  yard: { th: 'แผนผังลาน', en: 'Yard Plan' },
  units: { th: 'รายการรถ', en: 'Unit List' },
  rules: { th: 'ตั้งค่ากฎจอด', en: 'Parking Rules' },
  yardops: { th: 'Yard Ops (มือถือ)', en: 'Yard Ops' },
  tracking: { th: 'ติดตาม GPS', en: 'GPS Tracking' },
  operation: { th: 'Operation', en: 'Operation' },
  pm: { th: 'แผน PM', en: 'PM Plan' },
  damages:   { th: 'Damages', en: 'Damages' },
  grouping: { th: 'Grouping', en: 'Grouping' },
  settings: { th: 'ตั้งค่า', en: 'Settings' },

  // common
  search: { th: 'ค้นหา', en: 'Search' },
  scan: { th: 'สแกน VIN', en: 'Scan VIN' },
  confirm: { th: 'ยืนยัน', en: 'Confirm' },
  cancel: { th: 'ยกเลิก', en: 'Cancel' },
  save: { th: 'บันทึก', en: 'Save' },
  total: { th: 'ทั้งหมด', en: 'Total' },
  arrived: { th: 'มาแล้ว', en: 'Arrived' },
  pending: { th: 'รอ', en: 'Pending' },
  model: { th: 'รุ่น', en: 'Model' },
  color: { th: 'สี', en: 'Color' },
  block: { th: 'บล็อก', en: 'Block' },
  row: { th: 'แถว', en: 'Row' },
  slot: { th: 'ช่อง', en: 'Slot' },
  driverName: { th: 'คนขับ', en: 'Driver' },
  time: { th: 'เวลา', en: 'Time' },
  position: { th: 'ตำแหน่ง', en: 'Position' },
  status: { th: 'สถานะ', en: 'Status' },
  damage: { th: 'ความเสียหาย', en: 'Damage' },
  inspected: { th: 'ตรวจแล้ว', en: 'Inspected' },
  vehicle: { th: 'รถยนต์', en: 'Vehicle' },
  date: { th: 'วันที่', en: 'Date' },
  lot: { th: 'ล็อต', en: 'Lot' },

  // dashboard kpis
  inYard: { th: 'อยู่ในลาน', en: 'In Yard' },
  parked: { th: 'จอดแล้ว', en: 'Parked' },
  expected: { th: 'รอเข้า Yard', en: 'Pre Gate-in' },
  damaged: { th: 'Damage', en: 'Damage' },
  yardFill: { th: 'ความจุที่ใช้', en: 'Yard Fill' },
  todayTrailers: { th: 'หางวันนี้', en: 'Trailers Today' },
  liveActivity: { th: 'กิจกรรมล่าสุด', en: 'Live Activity' },
  modelMix: { th: 'สัดส่วนรุ่นในลาน', en: 'Model Mix in Yard' },

  // import
  importTitle: { th: 'นำเข้าเลข VIN / รุ่น / สี', en: 'Import VIN / Model / Color' },
  dropExcel: { th: 'ลากไฟล์ Excel มาวาง หรือคลิกเพื่อเลือก', en: 'Drop Excel file here or click to browse' },
  excelHint: { th: 'รองรับ .xlsx .xls .csv — คอลัมน์: VIN, Model, Color, Trailer, Variant, Lot', en: 'Supports .xlsx .xls .csv — columns: VIN, Model, Color, Trailer, Variant, Lot' },
  loadSample: { th: 'โหลดข้อมูลตัวอย่าง', en: 'Load sample data' },
  downloadTemplate: { th: 'ดาวน์โหลดเทมเพลต', en: 'Download template' },
  imported: { th: 'นำเข้าแล้ว', en: 'Imported' },

  // trailers
  trailersTitle: { th: 'หางเทรลเลอร์จากโรงงาน (Grouping)', en: 'Inbound Trailers (Grouping)' },
  markArrived: { th: 'บันทึกว่ามาถึง', en: 'Mark arrived' },
  arrivedTrailers: { th: 'หางที่มาถึงแล้ว', en: 'Trailers arrived' },
  unitsOnTrailer: { th: 'คันบนหาง', en: 'units' },

  // gate in
  gateInTitle: { th: 'Walk-around / ตรวจรับเข้าลาน', en: 'Walk-around / Gate-In' },
  gateInScanHint: { th: 'สแกนหรือพิมพ์เลข VIN เพื่อตรวจรับรถเข้าลาน', en: 'Scan or type VIN to receive the vehicle into the yard' },
  confirmGateIn: { th: 'ยืนยันเข้าลาน', en: 'Confirm Gate-In' },
  addDamage: { th: 'เพิ่มตำหนิ', en: 'Add damage' },
  noDamage: { th: 'ไม่มีตำหนิ', en: 'No damage' },
  takePhoto: { th: 'ถ่ายรูป / แนบรูป', en: 'Photo' },
  severity: { th: 'ระดับ', en: 'Severity' },
  minor: { th: 'เล็กน้อย', en: 'Minor' },
  major: { th: 'รุนแรง', en: 'Major' },

  // driver
  driverTitle: { th: 'สแกนก่อนขับ → รับตำแหน่งจอด', en: 'Scan before driving → get parking slot' },
  driverScanHint: { th: 'สแกน VIN เพื่อรับตำแหน่งจอดอัตโนมัติ', en: 'Scan VIN to receive an auto-assigned slot' },
  goTo: { th: 'นำรถไปที่', en: 'Drive to' },
  startDriving: { th: 'เริ่มขับ', en: 'Start driving' },
  confirmParked: { th: 'ยืนยันจอดสำเร็จ', en: 'Confirm parked' },
  reassign: { th: 'ขอตำแหน่งอื่น', en: 'Re-assign' },
  chooseSlot: { th: 'เลือกตำแหน่งเอง (Semi)', en: 'Choose slot (Semi)' },
  noSlot: { th: 'ไม่พบตำแหน่งว่างตามกฎ', en: 'No valid slot under rules' },

  // yard
  yardTitle: { th: 'แผนผังลานจอด', en: 'Yard Plan' },
  clickBlock: { th: 'คลิกบล็อกเพื่อดูรายละเอียดช่องจอด', en: 'Click a block to inspect its slots' },
  legend: { th: 'คำอธิบายสี', en: 'Legend' },

  // units
  unitsTitle: { th: 'รายการรถทั้งหมด', en: 'All Units' },
  exportCsv: { th: 'ส่งออก CSV', en: 'Export CSV' },
  lastMove: { th: 'เคลื่อนไหวล่าสุด', en: 'Last Move' },

  // rules
  rulesTitle: { th: 'กฎการจอด (Auto / Semi Plan)', en: 'Parking Rules (Auto / Semi Plan)' },
  rulesIntro: {
    th: 'กำหนดว่าแต่ละรุ่นจอดได้บล็อกไหน แถวไหน และห้ามปนรุ่นในแถวหรือไม่ — เครื่องจะวางแผนจอดตามกฎนี้',
    en: 'Define which block / rows each model may use and whether rows may mix models — the engine plans by these rules.',
  },
  allowedBlocks: { th: 'บล็อกที่อนุญาต', en: 'Allowed blocks' },
  rowWindow: { th: 'ช่วงแถว', en: 'Row window' },
  exclusiveRow: { th: 'ห้ามปนรุ่นในแถว', en: 'No model-mixing in row' },
  allBlocks: { th: 'ทุกบล็อก', en: 'All blocks' },
  planMode: { th: 'โหมดวางแผน', en: 'Plan mode' },
  autoPlan: { th: 'Auto — เครื่องเลือกให้', en: 'Auto — engine decides' },
  semiPlan: { th: 'Semi — เลือกเองได้', en: 'Semi — operator can pick' },
  autoFill: { th: 'จัดจอดอัตโนมัติทั้งหมด', en: 'Auto-park all' },
}

export function makeT(lang: Lang) {
  return (key: keyof typeof D | string): string => {
    const e = D[key as string]
    return e ? e[lang] : (key as string)
  }
}

export type TFn = ReturnType<typeof makeT>
