-- Remove duplicate health_metrics rows, keeping only the lowest id per group
DELETE FROM health_metrics
WHERE id NOT IN (
  SELECT MIN(id)
  FROM health_metrics
  GROUP BY metric_type, date, value, source
);

-- Add unique constraint to prevent future duplicates
ALTER TABLE health_metrics
ADD CONSTRAINT health_metrics_type_date_value_source_unique
UNIQUE (metric_type, date, value, source);
