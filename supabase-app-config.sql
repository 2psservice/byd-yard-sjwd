-- app_config — ค่าตั้งค่ากลางที่แชร์ทุกเครื่อง (key/value jsonb)
-- ใช้เก็บ "ค่าเริ่มต้นของ Unit List" (คอลัมน์ + ช่องกรอง) ที่แอดมินตั้งให้ทุกคน
-- รันครั้งเดียวใน Supabase Dashboard → SQL Editor → Run

create table if not exists public.app_config (
  id         text primary key,
  value      jsonb not null,
  updated_at timestamptz default now()
);
