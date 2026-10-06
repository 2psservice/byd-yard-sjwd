-- units.updated_at — ต้องขยับทุกครั้งที่แถวถูกอัปเดต (ไม่ใช่แค่ตอน insert)
--
-- ทำไม: realtime ของตาราง units ตัดสิน "สำเนาเก่า / เสียงสะท้อนของตัวเอง" ด้วย updated_at ต่อ VIN
-- (useYard.ts → subscribeRealtime: `if (unitTs.get(vin) >= ts) return`). unitToRow() ไม่ส่ง updated_at ขึ้นมาเอง
-- ถ้าฐานข้อมูลไม่มี trigger/ค่าที่ทำให้มันขยับตอน UPDATE ค่านี้จะค้างอยู่ที่เวลา insert → ทุกอัปเดตตำแหน่งหลังครั้งแรกของรถแต่ละคัน
-- ถูกมองเป็นของเก่าและถูกทิ้ง การย้ายรถจะไปถึงเครื่องอื่นได้แค่ทาง broadcast "moves" และรอบ refresh ทุก 3 นาที เท่านั้น
-- (ตรวจจาก repo ไม่ได้ — schema ของ units ไม่อยู่ใน repo จึงต้องเช็กที่ฐานข้อมูลจริง)
--
-- วิธีใช้: Supabase Dashboard → SQL Editor
--   ขั้นที่ 1 รันสองคำสั่งตรวจ (อ่านอย่างเดียว) แล้วดูผล
--   ขั้นที่ 2 รันส่วนสร้าง trigger "เฉพาะเมื่อ" ขั้นที่ 1 ไม่พบ trigger ที่ตั้ง updated_at บนตาราง units
--   (สคริปต์ขั้นที่ 2 รันซ้ำได้ — create or replace / drop if exists)

-- ── ขั้นที่ 1: ตรวจ ───────────────────────────────────────────────────────────────
-- 1a) trigger ที่มีบนตาราง units
select tgname, pg_get_triggerdef(oid) as definition
from pg_trigger
where tgrelid = 'public.units'::regclass and not tgisinternal;

-- 1b) ค่า default ของคอลัมน์ (default now() ทำงานตอน insert เท่านั้น ไม่ใช่ตอน update)
select column_name, data_type, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'units' and column_name = 'updated_at';

-- ── ขั้นที่ 2: สร้าง trigger (รันเมื่อขั้นที่ 1 ไม่พบ trigger ที่ตั้ง new.updated_at) ─────────────
create or replace function public.units_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists units_touch_updated_at on public.units;
create trigger units_touch_updated_at
  before update on public.units
  for each row
  execute function public.units_touch_updated_at();

-- ถอนกลับ: drop trigger if exists units_touch_updated_at on public.units;
