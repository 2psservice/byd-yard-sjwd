-- app_config — ค่าตั้งค่ากลางที่แชร์ทุกเครื่อง (key/value jsonb)
-- ใช้เก็บ "ค่าเริ่มต้นของ Unit List" (คอลัมน์ + ช่องกรอง) ที่แอดมินตั้งให้ทุกคน
-- รันครั้งเดียวใน Supabase Dashboard → SQL Editor → Run
-- (แก้อาการ "บันทึกไม่สำเร็จ — ต้องมีตาราง app_config ใน Supabase")

create table if not exists public.app_config (
  id         text primary key,
  value      jsonb not null,
  updated_at timestamptz default now()
);

-- เปิด RLS + policy อนุญาตอ่าน/เขียน (แบบเดียวกับตาราง app_users / ops_queues)
alter table public.app_config enable row level security;

drop policy if exists "allow all app_config" on public.app_config;
create policy "allow all app_config" on public.app_config
  for all to anon, authenticated using (true) with check (true);
