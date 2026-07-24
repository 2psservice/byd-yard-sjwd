-- Optional columns on the damages table used by the gate-in master-defect
-- capture. Safe to run more than once. The app degrades gracefully if these
-- haven't been run yet (the extra fields stay on the device that captured them
-- until the columns exist), so run whenever convenient to sync across devices.

alter table public.damages add column if not exists remark  text; -- free-text remark
alter table public.damages add column if not exists area_th text; -- Thai part name
alter table public.damages add column if not exists item_th text; -- Thai defect name
