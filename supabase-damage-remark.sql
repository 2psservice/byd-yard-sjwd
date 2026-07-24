-- Adds the optional "remark" free-text column to the damages table.
-- Safe to run more than once. The app degrades gracefully if this hasn't been
-- run yet (remarks stay on the device that captured them until the column
-- exists), so run it whenever convenient to sync remarks across devices.

alter table public.damages add column if not exists remark text;
