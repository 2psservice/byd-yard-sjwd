-- yard_units — CUTOVER ส่วนที่ 2: สลับแอปไปใช้ตารางรายยาร์ด (รันเมื่อผลตรวจยอดของ supabase-yard-units-cutover.sql ได้ ok = true ทุกแถว)
-- ดูลำดับทั้งหมดที่ docs/cutover-step2.md · ย้อนกลับ: supabase-yard-units-rollback.sql
--
-- ทำสองอย่างตามลำดับ: (B3) ปิดการ "แก้" และ "ลบ" ตาราง units เดิม · (B4) เปิดสวิตช์ units_mode = yard_units
-- หลังรัน: เครื่องที่เปิดแอปอยู่จะเห็นป้ายให้รีเฟรชภายใน ~30 วินาที · เครื่องที่เปิดใหม่เข้าโหมดใหม่เอง

-- ── B3) ปิดการ "แก้" units เดิม (กันเครื่องที่ยังเป็นแอปรุ่นเก่าเขียนตำแหน่งลงตารางที่ไม่มีใครอ่านแล้ว) ──
-- เครื่องเก่าจะเห็นข้อความบันทึกไม่สำเร็จ แทนที่จะ "ยิงแล้วไม่ขึ้น" เงียบ ๆ · เพิ่มรถใหม่ (insert) ยังทำได้ — ทะเบียนรถ
create or replace function public.units_frozen_guard()
returns trigger
language plpgsql
as $$
begin
  raise exception 'units ถูกปิดการแก้ไข: แอปใช้ตาราง yard_units แล้ว (รีเฟรชแอปให้เป็นเวอร์ชันล่าสุด)' using errcode = 'P0001';
end;
$$;

drop trigger if exists units_frozen_guard on public.units;
create trigger units_frozen_guard
  before update on public.units
  for each row
  execute function public.units_frozen_guard();

-- ปิดการ "ลบ" ด้วย: yard_units ผูก FK กับ units แบบ on delete cascade — ถ้าเครื่องแอปรุ่นเก่ากดลบรถ / "ล้างข้อมูลยาร์ด"
-- (ลบ units ของยาร์ดนั้น + รถไม่มีป้ายยาร์ด) แถว yard_units ของรถคันนั้น "ทุกยาร์ด" จะถูกลบตาม · แอปรุ่นใหม่ในโหมด
-- yard_units ไม่ลบ units เลย (ลบเฉพาะ yard_units) จึงล็อกได้โดยไม่กระทบงาน
drop trigger if exists units_frozen_guard_delete on public.units;
create trigger units_frozen_guard_delete
  before delete on public.units
  for each row
  execute function public.units_frozen_guard();

-- ── B4) เปิดสวิตช์: แอปทุกเครื่องอ่าน/เขียน yard_units (เครื่องที่เปิดอยู่จะเห็นป้ายให้รีเฟรชภายใน ~30 วินาที) ──
insert into public.app_config (id, value, updated_at)
values ('units_mode', '{"mode":"yard_units"}'::jsonb, now())
on conflict (id) do update set value = excluded.value, updated_at = now();

notify pgrst, 'reload schema';

-- ผลตรวจ (คำสั่งสุดท้าย — Supabase SQL Editor แสดงผลเฉพาะคำสั่งสุดท้าย): ต้องได้ switch_mode = yard_units, units_locked = true และ units_delete_locked = true
select (select value ->> 'mode' from public.app_config where id = 'units_mode') as switch_mode,
       exists (select 1 from pg_trigger where tgrelid = 'public.units'::regclass and tgname = 'units_frozen_guard' and not tgisinternal) as units_locked,
       exists (select 1 from pg_trigger where tgrelid = 'public.units'::regclass and tgname = 'units_frozen_guard_delete' and not tgisinternal) as units_delete_locked;
