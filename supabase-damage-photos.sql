-- damages.photo_urls — เก็บรูปตำหนิได้หลายรูปต่อรายการ (เดิมเก็บได้รูปเดียวใน photo_url)
-- รันครั้งเดียวใน Supabase Dashboard → SQL Editor → Run

alter table public.damages
  add column if not exists photo_urls jsonb;
