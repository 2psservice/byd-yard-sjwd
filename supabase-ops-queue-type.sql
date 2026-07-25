-- Persist the work-queue category + sequence flag on ops_queues.
-- Without these columns every cloud round-trip stripped `type`, so a PM/PDI
-- queue whose name doesn't contain "pm"/"pdi" degraded to "งานพิเศษ" (no date
-- stamp) and a งานพิเศษ named with "PDI" stamped the PDI ladder by mistake.
--
-- Run once in the Supabase SQL editor.

alter table ops_queues add column if not exists type text;
alter table ops_queues add column if not exists kind text;
