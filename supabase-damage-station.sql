-- damages.station — สถานีที่ตรวจพบตำหนิ (Gate-in / PDI / ชื่อคิวงาน เช่น "Wash for sale")
-- รันครั้งเดียวใน Supabase Dashboard → SQL Editor → Run

alter table public.damages
  add column if not exists station text;
