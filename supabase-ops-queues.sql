-- ops_queues — คิวงาน Operation (PM / Wash / PDI / FINAL CHECK) sync ข้ามเครื่อง
-- รันครั้งเดียวใน Supabase Dashboard → SQL Editor → Run
-- (ตารางอื่น units/damages/tracking_rows/sites/blocks/trailers มีอยู่แล้ว)

create table if not exists public.ops_queues (
  id         text primary key,
  site_id    text,                       -- Site.id (ไม่ใส่ FK เพื่อกัน 23503 silent-fail)
  name       text not null,
  created_at timestamptz default now(),
  created_by text,
  items      jsonb not null default '[]',
  updated_at timestamptz default now()
);

alter table public.ops_queues enable row level security;

drop policy if exists "allow all ops_queues" on public.ops_queues;
create policy "allow all ops_queues" on public.ops_queues
  for all to anon, authenticated using (true) with check (true);
