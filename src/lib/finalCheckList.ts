/**
 * FINAL CHECK inspection sheet — the four tabs of the paper form:
 * Overall inspection · Control Stock Sheet · Additional Accessories · NG.
 *
 * The NG tab is not a checklist: it is free defect entry (ตำแหน่ง / ข้อบกพร่อง /
 * หมายเหตุ) and is rendered by the sheet itself, so it has no entry here.
 */
import type { CheckTab } from './checkSheet'

export const FINAL_CHECK_TABS: CheckTab[] = [
  {
    key: 'overall',
    label: 'Overall inspection',
    groups: [
      {
        title: 'Group 1 : Overall inspection',
        items: [
          { th: 'ล้างสีดูดฝุ่น / Washing' },
          { th: 'ตรวจสอบสีตัวถัง ขอบภายนอก ลักษณะของหลอดไฟ และกระจกของรถทั้งหมดให้อยู่ในสภาพสมบูรณ์' },
          { th: 'ตรวจดูว่าแรงดันลมยางอยู่ในค่าที่กำหนดหรือไม่ All Model 300 Kpa. (Safety factor 1.2 from tire pressure STD.)' },
          { th: 'ตรวจสอบหลังคาซันรูฟว่ามีน้ำรั่วหรือไม่' },
          { th: 'ตรวจสอบว่าชิ้นส่วนภายในทั้งหมดสะอาด บุบสลายหรือไม่' },
          { th: 'น้ำหล่อเย็น / coolant' },
          { th: 'น้ำยาล้างกระจกหน้า / Windshield washer fluid' },
          { th: 'น้ำมันเบรก / Brake fluid' },
          { th: 'ตรวจสอบคุณภาพทั่วไปภายในห้องเครื่องให้อยู่ในสภาพที่ปกติ' },
          { th: 'ตรวจสอบระบบการทำงานของระบบแอร์ (เย็นปกติหรือไม่)' },
          { th: 'ตรวจสอบการติดตั้ง ตรวจสอบว่าได้ต่อขั้วลบแล้วหรือไม่ (ไม่จำเป็นต้องถอดขั้วลบของแบตเตอรี่เหล็ก)' },
          { th: 'แรงดันไฟฟ้า (จะต้องชาร์จหรือเปลี่ยนแบตเตอรี่หากแรงดันไฟต่ำกว่า 12.3V) ให้วัดค่าหลักจากชาร์ต main battery', spec: 'แรงดันที่วัดได้ (V)' },
          { th: 'ตรวจเช็คช่วงล่าง (ยึดแน่น, รอยขีด)' },
          {
            th: 'SOC จะต้องอยู่ระหว่าง 60% สำหรับรถยนต์สำหรับการส่งมอบ',
            en: '(SOC shall not be below 60%) with Transport mode "OPEN" — SOC shall be between 60% for the vehicles FIS for Delivery',
          },
        ],
      },
    ],
  },
  {
    key: 'stock',
    label: 'Control Stock Sheet',
    groups: [
      {
        title: 'Group 1 : ภายในห้องโดยสาร / Inside',
        items: [
          { th: "คู่มือการใช้รถ ฉบับภาษาไทย / Owner's Manual (Thai Version)" },
          { th: 'สมุดรับประกัน / Warranty Book' },
          { th: 'สติกเกอร์ หมายเลขตัวถัง สำหรับติดสมุดรับประกัน / Vin Barcode sticker' },
          { th: 'ซองใส่คู่มือและสมุดรับประกัน' },
          { en: 'Eco Sticker' },
          { th: 'ฟิล์มกันรอยหน้าจอ infotainment' },
        ],
      },
      {
        title: 'Group 2 : ห้องเก็บสัมภาระท้ายรถ / Trunk Room',
        items: [
          { th: 'ถาดรองห้องเก็บสัมภาระท้ายรถ / Rear luggage compartment tray' },
          { th: 'พรม / ผ้ายาง ประจำรถ / Floor Carpet' },
          { th: 'กรอบป้ายทะเบียน / license plate frame' },
        ],
      },
    ],
  },
  {
    key: 'accessories',
    label: 'Additional Accessories',
    groups: [
      {
        title: 'Group 1 : ภายในห้องโดยสาร / Inside',
        items: [
          { en: 'NFC Card' },
          { th: 'CF Card เฉพาะ Model Atto 3' },
          { th: 'เลขตัวถัง / Chassis Number', spec: 'เลขตัวถัง' },
          { th: 'เลขมอเตอร์ / Motor number', spec: 'เลขมอเตอร์' },
        ],
      },
      {
        title: 'Group 2 : ห้องเก็บสัมภาระท้ายรถ / Trunk Room',
        items: [
          { th: 'สายต่อไฟ / V2L Extension' },
          { th: 'เครื่องชาร์จฉุกเฉิน / AC Portable' },
          { th: 'ใบปัดน้ำฝน / Wiper Rubber' },
          { th: 'ป้ายจราจรฉุกเฉิน / Emergency traffic sign' },
          { th: 'เสื้อสะท้อนแสง / Reflective vest' },
          { th: 'ชุดปะยาง / Air pump / Emergency tire repair' },
          { th: 'แคลมป์ถอดฝาครอบน๊อตล้อ / Clamp' },
          { th: 'ห่วงลากจูง / Tow Hook' },
        ],
      },
    ],
  },
]
