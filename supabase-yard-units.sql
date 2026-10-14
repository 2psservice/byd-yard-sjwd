-- yard_units — ตัวรถบนผัง "ต่อยาร์ด" (PK = site_id + vin)
-- แยกข้อมูลรายยาร์ด ขั้นที่ 2 (ดู docs/site-separation-design.md §3.2 และ §5.1)
--   ตาราง units เดิมมี 1 แถวต่อ VIN ย้ายยาร์ด = เปลี่ยนป้าย site_id + ล้างช่อง → สำเนาค้างบนเครื่องอื่นเขียนทับได้
--   yard_units เก็บ 1 แถวต่อ (ยาร์ด, VIN): รถที่ผ่านหลายยาร์ดมีหลายแถว แถวของยาร์ดเดิมหลัง Gate-out เป็นประวัติ
--   ไม่มีใครเขียนทับ · ตำแหน่ง/สถานะบนผัง/คนขับ/Gate-in เป็นของยาร์ดนั้นล้วน ๆ
--   units ยังอยู่เป็น "ทะเบียนรถ" (vin PK + รุ่น/สี + FK ของ damages) — รถ 1 คัน = 1 แถว ใช้ร่วมกันทุกยาร์ด
--
-- ฉบับร่าง — ยังไม่ได้รันบนฐานข้อมูลจริง · ห้ามรันก่อนมีวัน cutover (ดูเอกสาร §5.1 ลำดับ cutover)
-- รันใน Supabase Dashboard → SQL Editor (รันซ้ำได้ ไม่ทับข้อมูลที่แอปเขียนแล้ว) · units เดิมไม่ถูกแตะ
-- ย้อนกลับ = deploy build เก่า (ใช้ units เดิม) — ข้อมูลที่เขียนลง yard_units หลัง cutover จะไม่ตามไป

-- ── 1) ตาราง: คัดคอลัมน์/ชนิดจาก units จริง (schema ของ units ไม่อยู่ใน repo) ───────────────
create table if not exists public.yard_units (like public.units including defaults);

alter table public.yard_units alter column site_id set not null;
alter table public.yard_units alter column vin set not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'yard_units_pkey' and conrelid = 'public.yard_units'::regclass) then
    alter table public.yard_units add constraint yard_units_pkey primary key (site_id, vin);
  end if;
  -- ทะเบียนรถ: ทุกแถวต้องมีรถใน units (embed damages ผ่าน units ได้) — แอปเขียน units ก่อน yard_units เสมอ
  if not exists (select 1 from pg_constraint where conname = 'yard_units_vin_fkey' and conrelid = 'public.yard_units'::regclass) then
    alter table public.yard_units add constraint yard_units_vin_fkey
      foreign key (vin) references public.units (vin) on delete cascade;
  end if;
end $$;

-- ดึงเฉพาะยาร์ด + ซิงก์ส่วนต่าง + หา VIN ข้ามยาร์ด
create index if not exists yard_units_site_status_idx on public.yard_units (site_id, status);
create index if not exists yard_units_vin_idx on public.yard_units (vin);
create index if not exists yard_units_site_updated_idx on public.yard_units (site_id, updated_at);

-- ── 2) updated_at ขยับทุกครั้งที่แถวถูกอัปเดต (realtime ใช้ตัดสินสำเนาเก่า/เสียงสะท้อนของตัวเอง) ──
create or replace function public.yard_units_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists yard_units_touch_updated_at on public.yard_units;
create trigger yard_units_touch_updated_at
  before update on public.yard_units
  for each row
  execute function public.yard_units_touch_updated_at();

-- ── 3) RLS เหมือนตารางอื่น (allow-all — ความปลอดภัยเท่าเดิม) ───────────────────────────────
alter table public.yard_units enable row level security;
drop policy if exists "allow all yard_units" on public.yard_units;
create policy "allow all yard_units" on public.yard_units
  for all to anon, authenticated using (true) with check (true);

-- ── 4) realtime ───────────────────────────────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'yard_units') then
    alter publication supabase_realtime add table public.yard_units;
  end if;
end $$;

-- ── 5) backfill: 1 แถวใน units → 1 แถวที่ยาร์ดของรถ ─────────────────────────────────────────
-- ยาร์ด = units.site_id ถ้ามี · รถเก่าที่ units ไม่มีป้ายยาร์ด ใช้ป้ายจากแถวชีต (tracking_rows.site) แทน
-- (ไม่งั้นรถกลุ่มนี้หายจากผังหลัง cutover) · ไม่มียาร์ดทั้งสองที่ = ข้าม (ไม่มีผังให้ขึ้น)
-- สร้างคำสั่งจากรายชื่อคอลัมน์จริงของ yard_units (ตามชนิดจริงของฐาน)
-- on conflict do nothing: ถ้าแอปเขียนแถวใหม่กว่าลงตารางไปแล้ว ไม่ทับ
do $$
declare cols text; sel text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position),
         string_agg(case when column_name = 'site_id' then 'coalesce(u.site_id, t.site)' else 'u.' || quote_ident(column_name) end, ', ' order by ordinal_position)
    into cols, sel
  from information_schema.columns where table_schema = 'public' and table_name = 'yard_units' and is_generated = 'NEVER';
  execute format(
    'insert into public.yard_units (%s) select %s from public.units u '
    'left join public.tracking_rows t on t.vin = u.vin and t.deleted_at is null '
    'where coalesce(u.site_id, t.site) is not null '
    'on conflict (site_id, vin) do nothing', cols, sel);
end $$;

-- ── 6) ตรวจยอด (อ่านอย่างเดียว) — ต้องเท่ากันทุกยาร์ดก่อนเปิดใช้ build ใหม่ ──────────────────────
select coalesce(u.site_id, y.site_id) as site_id, u.n as units, y.n as yard_units, u.parked as units_parked, y.parked as yard_parked
from (select coalesce(un.site_id, t.site) as site_id, count(*) n, count(*) filter (where un.block is not null) parked
      from public.units un left join public.tracking_rows t on t.vin = un.vin and t.deleted_at is null
      where coalesce(un.site_id, t.site) is not null group by 1) u
full join (select site_id, count(*) n, count(*) filter (where block is not null) parked from public.yard_units group by 1) y using (site_id)
order by 1;

notify pgrst, 'reload schema';
