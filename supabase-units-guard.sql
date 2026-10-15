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
-- ใช้เมื่อไหร่ (14 ต.ค.): หลัง cutover ขั้น 2 (supabase-yard-units-flip.sql) ตาราง units ถูกปิดการแก้ทั้งหมดด้วย
--   units_frozen_guard อยู่แล้ว — ไฟล์นี้ "ไม่จำเป็น" · รันเฉพาะเมื่อยังไม่สลับ / เลื่อนวันสลับ / หรือย้อนกลับ
--   (supabase-yard-units-rollback.sql) แล้วกลับมาใช้ units — อยู่ร่วมกับ units_frozen_guard ได้ (frozen ทำงานก่อนตามชื่อ)
--
-- วิธีใช้: Supabase Dashboard → SQL Editor — รันทีละขั้น (คู่มือ: docs/units-guard-runbook.md)
--   ⚠ ห้ามรันทั้งไฟล์ในครั้งเดียว: ขั้นที่ 3 จบด้วย error โดยตั้งใจ อาจย้อนการติดตั้งของขั้นที่ 2 ไปด้วย
--   ขั้นที่ 1 ตรวจ (อ่านอย่างเดียว) · ขั้นที่ 2 ติดตั้ง (รันซ้ำได้) · ขั้นที่ 3 ทดสอบ (ย้อนกลับเองทั้งหมด)
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

-- ── ขั้นที่ 3: ทดสอบ (ไม่เปลี่ยนข้อมูลจริง) ─────────────────────────────────────────────
-- บล็อกเดียว: ลองเขียน 4 แบบ ตรวจผล แล้ว "จบด้วย error เสมอ" เพื่อให้ฐานข้อมูลย้อนทุกอย่างกลับเอง (รวม log ที่ทดสอบ)
-- ผลอยู่ในข้อความ error: ต้องขึ้น "ผลทดสอบ: ผ่านครบ 5/5" — ถ้าขึ้น "ไม่ผ่าน" ให้ส่งภาพมา
-- VIN ตัวอย่าง (NYB2, ตรวจ 15 ต.ค.): v_parked = จอดอยู่ S/2/22 · v_departed = ออกแล้ว (DEPARTED)
-- เปลี่ยนเป็นคันอื่นได้: คันแรกต้องจอดอยู่ (มี block) · คันที่สองต้อง DEPARTED
do $$
declare
  v_parked   text := 'LC0CH6CB8T0128132';
  v_departed text := 'LC0CE4CB9T4321198';
  r record;
  n_log int;
  ok int := 0;
  msg text := '';
begin
  select status, block into r from public.units where vin = v_parked;
  if r.block is null then raise exception 'ตั้งค่าไม่ถูก: % ไม่มีตำแหน่ง — เลือกคันที่จอดอยู่', v_parked; end if;
  select status into r from public.units where vin = v_departed;
  if r.status is distinct from 'DEPARTED' then raise exception 'ตั้งค่าไม่ถูก: % ไม่ใช่ DEPARTED', v_departed; end if;

  -- ก) ตัวกวาดเก่า: จอดอยู่ → EXPECTED ไม่มีตำแหน่ง ที่ยาร์ดเดิม → ต้องถูกกัน (ตำแหน่งคงเดิม)
  update public.units set status = 'EXPECTED', block = null, "row" = null, slot = null where vin = v_parked;
  select status, block into r from public.units where vin = v_parked;
  if r.block is not null and r.status <> 'EXPECTED' then ok := ok + 1; msg := msg || ' ก=ผ่าน'; else msg := msg || ' ก=ไม่ผ่าน'; end if;

  -- ข) Gate-out ปกติ → ต้องผ่าน
  update public.units set status = 'DEPARTED', block = null, "row" = null, slot = null where vin = v_parked;
  select status, block into r from public.units where vin = v_parked;
  if r.status = 'DEPARTED' and r.block is null then ok := ok + 1; msg := msg || ' ข=ผ่าน'; else msg := msg || ' ข=ไม่ผ่าน'; end if;

  -- ค) สำเนาเก่า: DEPARTED → EXPECTED ยาร์ดเดิม → ต้องถูกกัน
  update public.units set status = 'EXPECTED' where vin = v_departed;
  select status into r from public.units where vin = v_departed;
  if r.status = 'DEPARTED' then ok := ok + 1; msg := msg || ' ค=ผ่าน'; else msg := msg || ' ค=ไม่ผ่าน'; end if;

  -- ง) นำเข้ารอบใหม่ที่ยาร์ดเดิม (imported_at ใหม่) → ต้องผ่าน
  update public.units set status = 'EXPECTED', imported_at = now() where vin = v_departed;
  select status into r from public.units where vin = v_departed;
  if r.status = 'EXPECTED' then ok := ok + 1; msg := msg || ' ง=ผ่าน'; else msg := msg || ' ง=ไม่ผ่าน'; end if;

  -- จ) log ต้องมี 2 แถวจากการทดสอบนี้ (ก และ ค)
  select count(*) into n_log from public.unit_guard_log where vin in (v_parked, v_departed) and at >= now();
  if n_log = 2 then ok := ok + 1; msg := msg || ' log=ผ่าน'; else msg := msg || ' log=ไม่ผ่าน(' || n_log || ')'; end if;

  raise exception 'ผลทดสอบ: % % (ข้อความนี้เป็น error โดยตั้งใจ — ทุกอย่างถูกย้อนกลับแล้ว ข้อมูลจริงไม่เปลี่ยน)',
    case when ok = 5 then 'ผ่านครบ 5/5' else 'ไม่ผ่าน ' || ok || '/5' end, msg;
end $$;

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
