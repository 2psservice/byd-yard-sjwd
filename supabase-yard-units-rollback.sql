-- yard_units — ROLLBACK: กลับไปใช้ตาราง units เดิม
-- รันเมื่อเจอปัญหาหลังเปิดสวิตช์ · ข้อมูลที่เขียนลง yard_units หลังสลับไม่ตามไป (units เดิมคือสภาพ ณ ตอน cutover)
-- แล้วให้ทุกเครื่องรีเฟรชแอป (เครื่องที่เปิดอยู่จะเห็นป้ายให้รีเฟรชเองภายใน ~30 วินาที)

-- 1) ปิดสวิตช์: แอปกลับไปอ่าน/เขียน units
insert into public.app_config (id, value, updated_at)
values ('units_mode', '{"mode":"units"}'::jsonb, now())
on conflict (id) do update set value = excluded.value, updated_at = now();

-- 2) เปิดให้แก้ units ได้อีก
drop trigger if exists units_frozen_guard on public.units;

notify pgrst, 'reload schema';

-- ผลตรวจ (คำสั่งสุดท้าย): ต้องได้ switch_mode = units และ units_locked = false
select (select value ->> 'mode' from public.app_config where id = 'units_mode') as switch_mode,
       exists (select 1 from pg_trigger where tgrelid = 'public.units'::regclass and tgname = 'units_frozen_guard' and not tgisinternal) as units_locked;
