-- yard_units — CUTOVER ส่วนที่ 1: refresh + ตรวจยอด (ยังไม่สลับแอป — รันแล้วแอปยังทำงานเหมือนเดิม)
-- ดูลำดับทั้งหมดที่ docs/cutover-step2.md · เอกสารออกแบบ §5.1
--
-- ก่อนรัน (ต้องครบทุกข้อ):
--   1) ประกาศหยุดสแกน/นำเข้าไฟล์ทุกเครื่อง และรอให้ไม่มีใครเขียนตำแหน่ง
--   2) รัน scripts/backup-supabase.mjs เสร็จ ยอดตรงทุกตาราง
--   3) เคยรัน supabase-yard-units.sql แล้ว (สร้างตาราง yard_units + backfill ครั้งแรก)
--   4) build ใหม่ (ที่มีสวิตช์ units_mode) deploy ขึ้นแล้ว
--
-- รันทั้งไฟล์ได้ แล้วดูตารางผลตรวจยอดตอนท้าย — ทุกแถวต้องได้ ok = true จึงไปรัน supabase-yard-units-flip.sql

-- ── B1) refresh yard_units จาก units (ปลอดภัย: ยังไม่มีเครื่องไหนเขียน yard_units) ─────────────
-- ย้ายเฉพาะรถที่ units มีป้ายยาร์ด (รถเก่าที่ไม่มีป้าย "ไม่ย้าย" — ตัดสินใจแล้ว) · เขียนทับแถวเดิมของ yard_units ด้วยค่าล่าสุดของ units
do $$
declare cols text; sets text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into cols
  from information_schema.columns where table_schema = 'public' and table_name = 'yard_units' and is_generated = 'NEVER';
  select string_agg(quote_ident(column_name) || ' = excluded.' || quote_ident(column_name), ', ' order by ordinal_position) into sets
  from information_schema.columns where table_schema = 'public' and table_name = 'yard_units' and is_generated = 'NEVER' and column_name not in ('site_id', 'vin');
  execute format(
    'insert into public.yard_units (%1$s) select %1$s from public.units where site_id is not null '
    'on conflict (site_id, vin) do update set %2$s', cols, sets);
end $$;

-- ── B2) ตรวจยอด (อ่านอย่างเดียว) — ทุกแถวต้องได้ ok = true ───────────────────────────────────
select coalesce(u.site_id, y.site_id) as site_id, u.n as units, y.n as yard_units, u.parked as units_parked, y.parked as yard_parked,
       (u.n is not distinct from y.n and u.parked is not distinct from y.parked) as ok
from (select site_id, count(*) n, count(*) filter (where block is not null) parked from public.units where site_id is not null group by 1) u
full join (select site_id, count(*) n, count(*) filter (where block is not null) parked from public.yard_units group by 1) y using (site_id)
order by 1;
-- ถ้ามีแถวใดที่ ok = false ให้หยุด ห้ามรัน supabase-yard-units-flip.sql แล้วแจ้งผู้ดูแลระบบ

-- รถที่ "ไม่ถูกย้าย" (units ไม่มีป้ายยาร์ด) — ดูไว้เฉยๆ ไม่มีผลต่อ ok: untagged_with_slot = ที่ยังมีช่องจอดค้างอยู่ (จะไม่ขึ้นผังหลังสลับ)
select count(*) as untagged_total, count(*) filter (where block is not null) as untagged_with_slot from public.units where site_id is null;
