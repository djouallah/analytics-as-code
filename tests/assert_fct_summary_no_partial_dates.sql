-- Crater tripwire: a date that lands PARTIALLY in the summary and is then never completed.
-- Mechanism: during backfill a date enters the summary with only the intervals fct_scada
-- happened to hold at that moment (typically the 49 from the previous day's archive file);
-- the daily branch used to skip any date already present, so the rest of the day never
-- arrived. fct_summary now reprocesses dates it holds partially, which heals these -- this
-- test is the guard that it keeps working. Observed 2025-09-13: 49 in the summary, 288 in
-- fct_scada.
--
-- Compares against fct_scada, NOT against a fixed 288, because "short" and "wrong" are not
-- the same thing. A date can be short at the SOURCE: its first ~4h live in the PREVIOUS
-- day's archive file, so until the backfill loads that file the date sits legitimately
-- capped. fct_scada agrees with the summary on those, and flagging them is noise.
-- Do not re-derive this as "the previous day is missing, so the cap is permanent" -- it
-- usually is not; comparing against the source is what makes the distinction
-- self-correcting.
--
-- The 280 pre-filter is a cheap shortlist off fct_summary alone, not the assertion; only
-- those few dates are probed against fct_scada (measured: ~46s for 2 dates vs ~233s for a
-- full-year aggregate). The latest date is excluded -- it is legitimately still filling.

WITH per_date AS (
  SELECT date, COUNT(DISTINCT time) AS intervals
  FROM {{ ref('fct_summary') }}
  WHERE date >= current_date - INTERVAL 12 MONTH
  GROUP BY date
),
short AS (
  SELECT date, intervals FROM per_date
  WHERE date < (SELECT MAX(date) FROM per_date) AND intervals < 280
)
SELECT *
FROM (
  SELECT
    s.date,
    s.intervals AS summary_intervals,
    (SELECT COUNT(DISTINCT sc.SETTLEMENTDATE)
     FROM {{ ref('fct_scada') }} sc
     WHERE sc.DATE = s.date AND sc.INTERVENTION = 0 AND sc.INITIALMW <> 0) AS scada_intervals
  FROM short s
) x
WHERE summary_intervals < scada_intervals
ORDER BY date
