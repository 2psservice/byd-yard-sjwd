-- app_users — บัญชี login (admin/driver/walkAround/pmPdiFinal/mechanic) sync ข้ามเครื่อง
-- รันครั้งเดียวใน Supabase Dashboard → SQL Editor → Run
-- ก่อนหน้านี้ appUsers เก็บแค่ในเครื่อง (localStorage) — บัญชีที่แอดมินสร้างจากคอมพิวเตอร์
-- จะ login จากมือถือพนักงานไม่ได้เลย เพราะแต่ละเครื่องมีรายชื่อผู้ใช้แยกกันคนละชุด

create table if not exists public.app_users (
  id         text primary key,
  name       text not null,
  role       text not null,
  username   text not null,
  password   text not null,
  active     boolean not null default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.app_users enable row level security;

drop policy if exists "allow all app_users" on public.app_users;
create policy "allow all app_users" on public.app_users
  for all to anon, authenticated using (true) with check (true);
