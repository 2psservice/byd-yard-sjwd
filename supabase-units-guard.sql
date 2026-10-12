-- units guard — กันเครื่องที่ถือข้อมูลเก่าเขียนทับ "ตำแหน่ง/สถานะ" ของรถในคลาวด์
--
-- ทำไม: ตั้งแต่ 3 ต.ค. รถที่จอดแล้วถูกเขียนกลับเป็น EXPECTED ไม่มีช่อง ที่ยาร์ดเดิม เป็นก้อน (NYB2 142 คัน 8 ต.ค. 09:53,
-- 3D LCB 286 คัน, 60 RAI 80 คัน) โดยแถวติดตามไม่ถูกแตะ — ลายเซ็นของตัวกวาด "ป้ายยาร์ดไม่ตรง → moveUnitsToSite"
-- ที่ถอดออกจากแอปแล้ว (commit 9220c6d, 6 ต.ค.) แต่ยังรันบนเครื่องที่ไม่อัปเดต และ 10 ต.ค. 12:42 รถ NYB2 1,066 คัน
-- ถูกเขียนสถานะจากสำเนาเก่าในวินาทีเดียว (รถที่ออกแล้วกลับเป็น EXPECTED). แก้ในแอปช่วยเฉพาะเครื่องที่อัปเดตแล้ว
-- บังคับอัปเดตเครื่องคนอื่นไม่ได้ → ต้องกันที่ฐานข้อมูล
--
-- ทำอะไร: trigger BEFORE UPDATE บนตาราง units "คงค่าเดิม" (ไม่ error) เมื่อเป็นการเขียนแบบที่โค้ดปัจจุบันไม่มีทางทำ:
--   กฎ 1  รถมีตำแหน่ง → EXPECTED ไม่มีตำแหน่ง ที่ยาร์ดเดิม (ตัวกวาดเก่า)
--   กฎ 2  DEPARTED → EXPECTED ที่ยาร์ดเดิม โดยไม่ใช่การนำเข้ารอบใหม่ (imported_at ไม่ใหม่กว่าเดิม) (สำเนาเก่า)
-- ทุกครั้งที่กัน จดลง unit_guard_log พร้อม header ของคำขอ (user-agent/IP) — ใช้หาเครื่องที่ยังไม่อัปเดต
--
-- ไม่กระทบทางปกติ: Gate-out (→ DEPARTED) · ยกเลิกขับ / Gate-in (→ GATE_IN / PARKED) · ย้ายยาร์ดจริง (site_id เปลี่ยน)
--   · นำเข้ารถรอบใหม่ที่ยาร์ดเดิม (imported_at ใหม่กว่า) · ลบรถ · เพิ่มรถใหม่ (INSERT ไม่ผ่าน trigger นี้)
-- ทำไม "คงค่าเดิม" ไม่ใช่ error: แอปเขียนเป็นก้อนละ 200 คัน — error คันเดียวทำให้ทั้งก้อนล้ม (รวมคันที่ถูกต้อง)
-- ลำดับ trigger: ชื่อ units_guard_* ทำงานก่อน units_touch_updated_at (เรียงตามชื่อ) → updated_at ยังขยับ
--   ทำให้ realtime ส่ง "ค่าที่ถูก" กลับไปแก้สำเนาของเครื่องที่เขียนผิด
--
-- วิธีใช้: Supabase Dashboard → SQL Editor — รันทีละขั้น
--   ขั้นที่ 1 ตรวจ (อ่านอย่างเดียว) · ขั้นที่ 2 ติดตั้ง (รันซ้ำได้) · ขั้นที่ 3 ทดสอบใน transaction แล้ว rollback
--   ขั้นที่ 4 ดู log · ถอนกลับอยู่ท้ายไฟล์

-- ── ขั้นที่ 1: ตรวจ ───────────────────────────────────────────────────────────────
-- 1a) trigger ที่มีบนตาราง units (ควรเห็น units_touch_updated_at; ถ้าไม่มี ให้รัน supabase-units-updated-at.sql ก่อน)
select tgname, pg_get_triggerdef(oid) as definition
from pg_trigger
where tgrelid = 'public.units'::regclass and not tgisinternal;

-- 1b) ชนิดคอลัมน์ที่ trigger ใช้
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public' and table_name = 'units'
  and column_name in ('vin', 'site_id', 'status', 'block', 'row', 'slot', 'imported_at', 'updated_at');

-- ── ขั้นที่ 2: ติดตั้ง ────────────────────────────────────────────────────────────
create table if not exists public.unit_guard_log (
  id       bigserial primary key,
  at       timestamptz not null default now(),
  vin      text not null,
  rule     text not null,
  old_row  jsonb,
  new_row  jsonb,
  headers  jsonb
);
create index if not exists unit_guard_log_at_idx on public.unit_guard_log (at desc);

-- อ่านได้จากแอป/สคริปต์ตรวจ (anon) แต่เขียนได้เฉพาะ trigger (security definer)
alter table public.unit_guard_log enable row level security;
drop policy if exists "read unit_guard_log" on public.unit_guard_log;
create policy "read unit_guard_log" on public.unit_guard_log for select to anon, authenticated using (true);

create or replace function public.units_guard_stale_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rule text;
  v_headers jsonb;
begin
  -- กฎ 1: รถมีตำแหน่ง ถูกเขียนเป็น EXPECTED ไม่มีตำแหน่ง ที่ยาร์ดเดิม
  if old.block is not null
     and new.block is null
     and new.status = 'EXPECTED'
     and old.status is distinct from 'EXPECTED'
     and new.site_id is not distinct from old.site_id then
    v_rule := 'parked_to_expected_same_site';
  -- กฎ 2: รถที่ออกไปแล้ว ถูกเขียนกลับเป็น EXPECTED ที่ยาร์ดเดิม โดยไม่ใช่การนำเข้ารอบใหม่
  elsif old.status = 'DEPARTED'
     and new.status = 'EXPECTED'
     and new.site_id is not distinct from old.site_id
     and coalesce(new.imported_at, 'epoch'::timestamptz) <= coalesce(old.imported_at, 'epoch'::timestamptz) then
    v_rule := 'departed_to_expected_same_site';
  end if;

  if v_rule is null then
    return new;
  end if;

  begin
    v_headers := nullif(current_setting('request.headers', true), '')::jsonb;
  exception when others then
    v_headers := null;
  end;
  insert into public.unit_guard_log (vin, rule, old_row, new_row, headers)
  values (old.vin, v_rule, to_jsonb(old), to_jsonb(new), v_headers);

  return old; -- คงค่าเดิมทั้งแถว (updated_at จะถูกขยับโดย units_touch_updated_at ที่ทำงานถัดไป)
end;
$$;

drop trigger if exists units_guard_stale_write on public.units;
create trigger units_guard_stale_write
  before update on public.units
  for each row
  execute function public.units_guard_stale_write();

-- ── ขั้นที่ 3: ทดสอบ (ไม่เปลี่ยนข้อมูลจริง — ทุกอย่าง rollback) ───────────────────────────
-- เปลี่ยน VIN ด้านล่างเป็นรถที่ "จอดอยู่ มีตำแหน่ง" หนึ่งคัน และรถที่ "DEPARTED" หนึ่งคัน ที่ยาร์ดเดียวกัน
begin;
  -- ก) จำลองตัวกวาดเก่า → ต้องคงตำแหน่งเดิม (คาด: status เดิม, block ไม่ว่าง)
  update public.units set status = 'EXPECTED', block = null, "row" = null, slot = null
  where vin = 'VIN_ที่จอดอยู่';
  select vin, status, block, "row", slot from public.units where vin = 'VIN_ที่จอดอยู่';

  -- ข) Gate-out ปกติ → ต้องผ่าน (คาด: DEPARTED, block ว่าง)
  update public.units set status = 'DEPARTED', block = null, "row" = null, slot = null
  where vin = 'VIN_ที่จอดอยู่';
  select vin, status, block from public.units where vin = 'VIN_ที่จอดอยู่';

  -- ค) สำเนาเก่าเขียนรถที่ออกแล้วกลับเป็น EXPECTED → ต้องคง DEPARTED
  update public.units set status = 'EXPECTED' where vin = 'VIN_ที่ออกแล้ว';
  select vin, status from public.units where vin = 'VIN_ที่ออกแล้ว';

  -- ง) นำเข้ารอบใหม่ที่ยาร์ดเดิม (imported_at ใหม่) → ต้องผ่าน (คาด: EXPECTED)
  update public.units set status = 'EXPECTED', imported_at = now() where vin = 'VIN_ที่ออกแล้ว';
  select vin, status from public.units where vin = 'VIN_ที่ออกแล้ว';

  -- ควรมี 2 แถวใน log (ก และ ค)
  select vin, rule from public.unit_guard_log order by id desc limit 5;
rollback;

-- ── ขั้นที่ 4: ดูว่ากันอะไรไปบ้าง / มาจากเครื่องไหน ────────────────────────────────────
select date_trunc('minute', at) as minute, rule, count(*) as n,
       min(headers->>'user-agent') as user_agent,
       min(headers->>'x-forwarded-for') as ip
from public.unit_guard_log
group by 1, 2
order by 1 desc
limit 50;

-- ── ถอนกลับ ──────────────────────────────────────────────────────────────────────
-- drop trigger if exists units_guard_stale_write on public.units;
-- drop function if exists public.units_guard_stale_write();
-- (เก็บ unit_guard_log ไว้ได้ หรือ: drop table if exists public.unit_guard_log;)
