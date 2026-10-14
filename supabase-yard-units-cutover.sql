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
-- ยาร์ดของรถ = units.site_id หรือ (ถ้าไม่มี) tracking_rows.site · เขียนทับแถวเดิมของ yard_units ทั้งหมดด้วยค่าล่าสุดของ units
do $$
declare cols text; sets text; sel text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position),
         string_agg(case when column_name = 'site_id' then 'coalesce(u.site_id, t.site)' else 'u.' || quote_ident(column_name) end, ', ' order by ordinal_position)
    into cols, sel
  from information_schema.columns where table_schema = 'public' and table_name = 'yard_units' and is_generated = 'NEVER';
  select string_agg(quote_ident(column_name) || ' = excluded.' || quote_ident(column_name), ', ' order by ordinal_position) into sets
  from information_schema.columns where table_schema = 'public' and table_name = 'yard_units' and is_generated = 'NEVER' and column_name not in ('site_id', 'vin');
  execute format(
    'insert into public.yard_units (%s) select %s from public.units u '
    'left join public.tracking_rows t on t.vin = u.vin and t.deleted_at is null '
    'where coalesce(u.site_id, t.site) is not null '
    'on conflict (site_id, vin) do update set %s', cols, sel, sets);
end $$;

-- ── B2) ตรวจยอด (อ่านอย่างเดียว) — ทุกแถวต้องได้ ok = true ───────────────────────────────────
select coalesce(u.site_id, y.site_id) as site_id, u.n as units, y.n as yard_units, u.parked as units_parked, y.parked as yard_parked,
       (u.n is not distinct from y.n and u.parked is not distinct from y.parked) as ok
from (select coalesce(un.site_id, t.site) as site_id, count(*) n, count(*) filter (where un.block is not null) parked
      from public.units un left join public.tracking_rows t on t.vin = un.vin and t.deleted_at is null
      where coalesce(un.site_id, t.site) is not null group by 1) u
full join (select site_id, count(*) n, count(*) filter (where block is not null) parked from public.yard_units group by 1) y using (site_id)
order by 1;
-- ถ้ามีแถวใดที่ ok = false ให้หยุด ห้ามรัน B3–B4 แล้วแจ้งผู้ดูแลระบบ
