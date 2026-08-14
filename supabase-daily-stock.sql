-- ══════════════════════════════════════════════════════════════════════════
-- daily_stock — รายงานประจำวัน (Local Production Stock) คำนวณบนเซิร์ฟเวอร์
-- ทุกจอถามวันเดียวกัน → ยกมา/เข้า/ออก/คงเหลือ เลขชุดเดียวกันเป๊ะ (แบบ N4)
-- รันครั้งเดียวใน Supabase Dashboard → SQL Editor → Run
-- (ตรรกะเป็น port ของ DailyStockReport + dayKey.ts: gateInDateKey/gateOutDateKey)
-- ══════════════════════════════════════════════════════════════════════════

-- helper: parseLooseDate — แยกเป็นฟังก์ชันเพื่อไม่ต้องเขียน 3 รูปแบบซ้ำหลายจุด
create or replace function public.__sjwd_loose_date(s text)
returns date
language sql
immutable
as $$
  select case
    -- ISO: 2026-08-14
    when m1 is not null and m1[2]::int between 1 and 12 then
      (make_date(m1[1]::int, m1[2]::int, 1) + ((m1[3]::int - 1) * interval '1 day'))::date
    -- Excel short date: 20-May-26 / 20-May-2026
    when m2 is not null and mon.idx is not null then
      (make_date(case when length(m2[3]) = 2 then 2000 + m2[3]::int else m2[3]::int end, mon.idx, 1)
        + ((m2[1]::int - 1) * interval '1 day'))::date
    -- Thai day-first: 14/08/2026
    when m3 is not null and m3[2]::int between 1 and 12 then
      (make_date(m3[3]::int, m3[2]::int, 1) + ((m3[1]::int - 1) * interval '1 day'))::date
    else null
  end
  from (select
    regexp_match(trim(coalesce(s, '')), '^(\d{4})-(\d{1,2})-(\d{1,2})') as m1,
    regexp_match(trim(coalesce(s, '')), '^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})') as m2,
    regexp_match(trim(coalesce(s, '')), '^(\d{1,2})/(\d{1,2})/(\d{4})') as m3
  ) r
  cross join lateral (select array_position(array['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'],
    lower(coalesce(r.m2[2], ''))) as idx) mon
$$;


create or replace function public.daily_stock(p_site_id text default null, p_names text[] default null, p_day date default null)
returns jsonb
language sql
stable
as $$
with args as (
  select coalesce(p_day, (now() at time zone 'Asia/Bangkok')::date) as day
),
scoped as (
  select t.cells
  from public.tracking_rows t
  where t.deleted_at is null
    and coalesce(trim(t.cells->>'Vin'), '') <> ''
    and (
      p_site_id is null
      or t.site = p_site_id
      or (
        coalesce(t.site, '') = ''
        and p_names is not null
        and lower(regexp_replace(trim(coalesce(t.cells->>'Location yard', '')), '\s+', ' ', 'g')) = any (p_names)
      )
    )
),
f as (
  select
    trim(coalesce(s.cells->>'Vin', ''))                    as vin,
    trim(coalesce(s.cells->>'Car Status', ''))             as explicit,
    coalesce(s.cells->>'Gate Out time stamp', '')          as stamp,
    coalesce(s.cells->>'Gate Out Date', '')                as gdate,
    coalesce(s.cells->>'Vin Of Status', '')                as vos,
    trim(coalesce(s.cells->>'Grouping  Number', ''))       as grp,
    trim(coalesce(s.cells->>'Gate In (Rayong yard)', ''))  as gatein,
    trim(coalesce(s.cells->>'storage Yard', ''))           as storage,
    coalesce(s.cells->>'Location yard', '')                as loc,
    -- DailyStock's modelOf prefers "Model name" FIRST (ต่างจาก Dashboard)
    coalesce(nullif(trim(coalesce(s.cells->>'Model name', '')), ''),
             nullif(trim(coalesce(s.cells->>'Model', '')), ''), '—') as model,
    coalesce(nullif(trim(coalesce(s.cells->>'Color', '')), ''), '—') as color,
    case when coalesce(s.cells->>'Gate In Time', '') ~ '^\d+$'
         then (s.cells->>'Gate In Time')::numeric else 0 end as gi_ms,
    case when coalesce(s.cells->>'Gate Out Time', '') ~ '^\d+$'
         then (s.cells->>'Gate Out Time')::numeric else 0 end as go_ms
  from scoped s
),
g as (
  select f.*,
    (f.stamp ~ '\d' and regexp_replace(lower(f.stamp),
      '(\d+|[/\-.:,]|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|am|pm|น|\s)', '', 'g') = '') as stamp_is_bare,
    (f.gdate ~ '\d' and regexp_replace(lower(f.gdate),
      '(\d+|[/\-.:,]|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|am|pm|น|\s)', '', 'g') = '') as gdate_is_bare,
    regexp_match(f.stamp, '(\d{1,2})/(\d{1,2})/(\d{4})') as plan_dmy,
    regexp_match(f.stamp, '(\d{1,2})/(\d{1,2})/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?') as scan_m
  from f
),
-- parseLooseDate (dayKey.ts) เป็น SQL: ISO / dd-Mon-yy / dd/mm/yyyy — คืน null
-- เมื่อไม่เข้ารูปแบบ (ไม่เดารูปแบบกำกวม). make_date(y,m,1)+(d-1) วัน = JS Date
-- rollover (31 ก.พ. → มี.ค.) เพื่อให้ตรงกับ new Date(y, m-1, d)
h as (
  select g.*,
    -- gate-in day: exact epoch stamp first, else parse the imported date
    case
      when g.gi_ms > 0 then (to_timestamp(g.gi_ms / 1000.0) at time zone 'Asia/Bangkok')::date
      else public.__sjwd_loose_date(g.gatein)
    end as gi,
    -- Pre-Gate-out scan moment (Bangkok wall clock) for the 09:30 flush rule
    case
      when g.go_ms > 0 then (to_timestamp(g.go_ms / 1000.0) at time zone 'Asia/Bangkok')
      when g.scan_m is not null
           and g.scan_m[2]::int between 1 and 12 and g.scan_m[1]::int between 1 and 31 then
        make_date(g.scan_m[3]::int, g.scan_m[2]::int, 1)::timestamp
          + ((g.scan_m[1]::int - 1) * interval '1 day')
          + (coalesce(g.scan_m[4], '0')::int * interval '1 hour')
          + (coalesce(g.scan_m[5], '0')::int * interval '1 minute')
      else null
    end as scan_ts,
    -- gate-out day: bare stamp → bare Gate Out Date → lapsed plan (embedded dmy)
    case
      when g.stamp_is_bare then public.__sjwd_loose_date(g.stamp)
      when g.gdate_is_bare then public.__sjwd_loose_date(g.gdate)
      when (not g.stamp_is_bare)
           and g.plan_dmy is not null
           and g.plan_dmy[2]::int between 1 and 12
           and g.plan_dmy[1]::int between 1 and 31
           and (g.plan_dmy[3]::int, g.plan_dmy[2]::int, g.plan_dmy[1]::int)
             < (extract(year  from (now() at time zone 'Asia/Bangkok')::date - 2)::int,
                extract(month from (now() at time zone 'Asia/Bangkok')::date - 2)::int,
                extract(day   from (now() at time zone 'Asia/Bangkok')::date - 2)::int)
        then make_date(g.plan_dmy[3]::int, g.plan_dmy[2]::int, 1) + ((g.plan_dmy[1]::int - 1) * interval '1 day')
      else null
    end::date as go
  from g
),
d as (
  select h.*,
    case
      when h.vos ~* 'total\s*loss' then 'Total loss'
      when (not h.stamp_is_bare)
           and h.plan_dmy is not null
           and h.plan_dmy[2]::int between 1 and 12
           and h.plan_dmy[1]::int between 1 and 31
           and (h.plan_dmy[3]::int, h.plan_dmy[2]::int, h.plan_dmy[1]::int)
             < (extract(year  from (now() at time zone 'Asia/Bangkok')::date - 2)::int,
                extract(month from (now() at time zone 'Asia/Bangkok')::date - 2)::int,
                extract(day   from (now() at time zone 'Asia/Bangkok')::date - 2)::int)
        then 'Gate-out'
      when h.explicit = 'Pre Gate-out' then
        case when h.scan_ts is not null
              and (now() at time zone 'Asia/Bangkok') >=
                  (case when date_trunc('day', h.scan_ts) + interval '9 hours 30 minutes' <= h.scan_ts
                        then date_trunc('day', h.scan_ts) + interval '1 day 9 hours 30 minutes'
                        else date_trunc('day', h.scan_ts) + interval '9 hours 30 minutes' end)
             then 'Gate-out' else 'Pre Gate-out' end
      when h.explicit ~* '^parking\s+\S' or h.explicit ~* '\s(ok|ng)$' then 'In Yard'
      when h.explicit <> '' then h.explicit
      when h.stamp_is_bare or h.gdate_is_bare then 'Gate-out'
      when h.grp <> '' then 'Ready'
      when h.gatein = '' or h.gatein = '—' then 'Pre Gate-in'
      when h.storage <> '' or h.loc ~* 'yard' then 'In Yard'
      else 'Gate-in'
    end as st
  from h
),
-- exclusions ตรงกับ DailyStockReport ทีละบรรทัด
e as (
  select d.*,
    case
      when d.st = 'Pre Gate-in' then 'undated'
      when d.st = 'Gate-out' and d.go is null then 'out_no_date'
      when d.gi is null and d.go is null then 'undated'
      else 'counted'
    end as bucket
  from d
),
c as (select e.*, (select day from args) as day from e where e.bucket = 'counted')
select jsonb_build_object(
  'day', (select day from args),
  'opening', (select count(*) from c where gi is not null and gi <= day - 1 and (go is null or go > day - 1)),
  'in_n',    (select count(*) from c where gi = day),
  'out_n',   (select count(*) from c where go = day),
  'stock_n', (select count(*) from c where gi is not null and gi <= day and (go is null or go > day)),
  'undated',     (select count(*) from e where bucket = 'undated'),
  'out_no_date', (select count(*) from e where bucket = 'out_no_date'),
  'in_list', coalesce((select jsonb_agg(jsonb_build_object('vin', vin, 'model', model, 'color', color, 'grouping', nullif(grp,'')) order by model, vin)
     from c where gi = day), '[]'::jsonb),
  'out_list', coalesce((select jsonb_agg(jsonb_build_object('vin', vin, 'model', model, 'color', color, 'grouping', nullif(grp,'')) order by model, vin)
     from c where go = day), '[]'::jsonb),
  'stock_list', coalesce((select jsonb_agg(jsonb_build_object('vin', vin, 'model', model, 'color', color, 'grouping', nullif(grp,'')) order by model, vin)
     from c where gi is not null and gi <= day and (go is null or go > day)), '[]'::jsonb),
  'stock_matrix', coalesce((select jsonb_agg(jsonb_build_object('model', model, 'color', color, 'n', n))
     from (select model, color, count(*) as n from c
           where gi is not null and gi <= day and (go is null or go > day)
           group by model, color) x), '[]'::jsonb)
)
$$;

grant execute on function public.daily_stock(text, text[], date) to anon, authenticated;
grant execute on function public.__sjwd_loose_date(text) to anon, authenticated;
