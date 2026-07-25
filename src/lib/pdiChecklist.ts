// ============================================================
//  PDI inspection checklist — structured OK / NG / NG Heavy form
//  (Equipment & Tools · Exterior · Interior · Engine · Under Body)
//  Each NG / NG Heavy item becomes a Defect in the damage system.
// ============================================================

export interface PdiCheckItem {
  en: string
  th?: string
  spec?: string // optional "ระบุ" field label (e.g. Qty / Key Code)
}
export interface PdiCheckGroup {
  title: string
  items: PdiCheckItem[]
}
export interface PdiCheckCategory {
  key: string
  label: string
  groups: PdiCheckGroup[]
}

/** Stable id for one checklist item (category key + group index + item index). */
export const pdiItemId = (catKey: string, gi: number, ii: number) => `${catKey}.${gi}.${ii}`

export const PDI_CHECKLIST: PdiCheckCategory[] = [
  {
    key: 'equip',
    label: 'Equipment & Tools',
    groups: [
      {
        title: 'Equipment & Tools Total',
        items: [
          { en: 'Remote / Key entry', spec: 'Qty' },
          { en: 'Key Code', spec: 'Key Code' },
          { en: 'Chassis Number', th: 'เลขตัวถัง' },
          { en: 'Motor number', th: 'เลขมอเตอร์' },
          { en: 'CF Card (Atto 3)' },
          { en: 'V2L Extension Outlet 1 Unit' },
          { en: 'Wiper Rubber 2 pieces' },
          { en: 'Emergency Charger 1 Unit' },
          { en: 'Air Pump / Emergency Tire Repair', th: 'ปั๊มลม / ซ่อมยางฉุกเฉิน' },
          { en: 'NFC Card' },
          { en: 'Emergency traffic sign', th: 'ป้ายจราจรฉุกเฉิน' },
          { en: 'Reflective vest', th: 'เสื้อสะท้อนแสง' },
          { en: 'Towing Hook', th: 'ตะขอลาก' },
        ],
      },
    ],
  },
  {
    key: 'ext',
    label: 'Exterior Inspection',
    groups: [
      {
        title: 'Front Vehicle',
        items: [
          { en: 'Wiper / Wiper blade', th: 'ที่ปัดน้ำฝน / ยางปัดน้ำฝน' },
          { en: 'Hood', th: 'ฝากระโปรง' },
          { en: 'Emblem', th: 'ตราสัญลักษณ์' },
          { en: 'Head Light RH', th: 'ไฟหน้าขวา' },
          { en: 'Head Light LH', th: 'ไฟหน้าซ้าย' },
          { en: 'Front Bumper', th: 'กันชนหน้า' },
          { en: 'Front Grill', th: 'กระจังหน้า' },
        ],
      },
      {
        title: 'LH - Front Fender and Front Door',
        items: [
          { en: 'F-LH Front Fender', th: 'แก้มหน้า' },
          { en: 'F-LH Wheel and Tire', th: 'ล้อและยาง' },
          { en: 'F-LH Side Mirror', th: 'กระจกมองข้าง' },
          { en: 'F-LH Door / Door Handle', th: 'ประตู / มือจับประตู' },
          { en: 'F-LH Window glass', th: 'กระจกประตู' },
          { en: 'F-LH Door rim rubber', th: 'ยางขอบประตู' },
          { en: 'F-LH Door trim', th: 'แผงประตู' },
        ],
      },
      {
        title: 'LH - Rear Door and Rear Fender',
        items: [
          { en: 'R-LH Door / Door Handle', th: 'ประตู / มือจับประตู' },
          { en: 'R-LH Window glass', th: 'กระจกประตู' },
          { en: 'R-LH Roof Rack', th: 'แร็คหลังคา' },
          { en: 'R-LH Fender', th: 'แก้มหลัง' },
          { en: 'R-LH Door rim rubber', th: 'ยางขอบประตู' },
          { en: 'R-LH Door trim', th: 'แผงประตู' },
          { en: 'R-LH Wheel and Tire', th: 'ล้อและยางหลังซ้าย' },
        ],
      },
      {
        title: 'Tailgate',
        items: [
          { en: 'Tailgate Glass', th: 'ฝาท้าย' },
          { en: '3rd Break Signal', th: 'ไฟเบรคดวงที่ 3' },
          { en: 'LH Tail Lamp', th: 'ไฟท้ายด้านซ้าย' },
          { en: 'RH Tail Lamp', th: 'ไฟท้ายด้านขวา' },
          { en: 'Emblem', th: 'ตราสัญลักษณ์' },
          { en: 'Licence plate', th: 'ป้ายทะเบียน' },
          { en: 'Cover Hook', th: 'ฝาครอบฮุก' },
          { en: 'Rear Bumper', th: 'กันชนด้านหลัง' },
          { en: 'Shelf assembly part', th: 'ถาดปิดของท้ายรถ' },
          { en: 'Tailgate rim rubber', th: 'ยางขอบประตูท้าย' },
          { en: 'Tank Room Panel', th: 'ห้องเก็บสัมภาระท้ายรถ' },
          { en: 'Wiper', th: 'ใบปัดน้ำฝน' },
        ],
      },
      {
        title: 'RH - Front Fender and Front Door',
        items: [
          { en: 'F-RH Front Fender', th: 'แก้มหน้า' },
          { en: 'F-RH Wheel and Tire', th: 'ล้อและยาง' },
          { en: 'F-RH Side Mirror', th: 'กระจกมองข้าง' },
          { en: 'F-RH Door / Door Handle', th: 'ประตู / มือจับประตู' },
          { en: 'F-RH Window glass', th: 'กระจกประตู' },
          { en: 'F-RH Door rim rubber', th: 'ยางขอบประตู' },
          { en: 'F-RH Door trim', th: 'แผงประตู' },
        ],
      },
      {
        title: 'RH - Rear Door and Rear Fender',
        items: [
          { en: 'R-RH Door / Door Handle', th: 'ประตู / มือจับประตู' },
          { en: 'R-RH Window glass', th: 'กระจกประตู' },
          { en: 'R-RH Roof Rack', th: 'แร็คหลังคา' },
          { en: 'R-RH Fender', th: 'แก้มหลัง' },
          { en: 'R-RH Door rim rubber', th: 'ยางขอบประตู' },
          { en: 'R-RH Door trim', th: 'แผงประตู' },
          { en: 'R-RH Wheel and Tire', th: 'ล้อและยางหลังขวา' },
        ],
      },
    ],
  },
  {
    key: 'int',
    label: 'Interior Inspection',
    groups: [
      {
        title: 'Interior Function',
        items: [
          { en: 'Steering wheel function', th: 'การทำงานของพวงมาลัย' },
          { en: 'Front / Rear camera', th: 'กล้องหน้า / หลัง' },
          { en: 'Left / Right camera', th: 'กล้องซ้าย / ขวา' },
          { en: 'Central screen', th: 'หน้าจอกลาง' },
          { en: 'Door Lock / Unlock', th: 'ล็อก / ปลดล็อคประตู' },
          { en: 'Turn signal L&R', th: 'ไฟเลี้ยวข้างซ้าย / ขวา' },
          { en: 'Sunroof', th: 'ซันรูฟ' },
          { en: 'Air conditioner', th: 'แอร์' },
          { en: 'Side mirror', th: 'กระจกมองข้าง' },
          { en: 'Sun visor light', th: 'ไฟที่บังแดด' },
        ],
      },
      {
        title: 'Basic Operating in Cockpit',
        items: [
          { en: 'Head Light On-Off', th: 'ไฟหน้า' },
          { en: 'Wiper Front / Rear', th: 'ที่ปัดน้ำฝนหน้า-หลัง' },
          { en: 'Horn', th: 'แตร' },
          { en: 'Room Lighting', th: 'ไฟในห้องโดยสาร' },
          { en: 'NFC Card', th: 'สมาร์ทการ์ด' },
          { en: 'Keyless Remote Entry', th: 'รีโมท' },
          { en: 'Window Operation Up-Down', th: 'เปิดกระจกขึ้นลง' },
        ],
      },
    ],
  },
  {
    key: 'engine',
    label: 'Engine compartment',
    groups: [
      {
        title: 'Engine Bay',
        items: [
          { en: 'Coolant Level', th: 'ระดับน้ำหล่อเย็น' },
          { en: 'Brake liquid Level', th: 'ระดับน้ำมันเบรค' },
          { en: 'Windshield washer fluid level', th: 'ระดับน้ำล้างกระจกหน้า' },
          { en: 'Battery terminal / battery strap', th: 'ขั้วแบตเตอรี่ / เข็มขัดรัดแบตเตอรี่' },
          { en: 'Battery 12V (Connecting Pole)' },
        ],
      },
    ],
  },
  {
    key: 'under',
    label: 'Under Body',
    groups: [
      {
        title: 'Under Body',
        items: [
          { en: 'Under Body Overall', th: 'สภาพใต้ท้องรถโดยรวม' },
        ],
      },
    ],
  },
]

export type PdiResult = 'OK' | 'NG' | 'NG Heavy'
