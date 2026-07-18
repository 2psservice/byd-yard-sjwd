-- tracking_rows.history — เก็บ log การแก้ไขทุกครั้ง (ทุก station + แอดมิน) ต่อ VIN
-- รันครั้งเดียวใน Supabase Dashboard → SQL Editor → Run

alter table public.tracking_rows
  add column if not exists history jsonb;
