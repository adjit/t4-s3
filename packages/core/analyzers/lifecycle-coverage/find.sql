SELECT
  '' AS prefix,
  'low' AS severity,
  0 AS reclaimable_bytes,
  CAST(json_object('uncovered_bytes', coalesce(sum(o.size), 0), 'uncovered_objects', count(*)) AS VARCHAR) AS details
FROM objects AS o
WHERE o.bucket = $bucket
  AND o.is_latest
  AND NOT o.is_delete_marker
  AND NOT EXISTS (
    SELECT 1
    FROM lifecycle_rules AS r
    WHERE r.bucket = o.bucket
      AND (r.prefix IS NULL OR r.prefix = '' OR starts_with(o.key, r.prefix))
  )
HAVING count(*) > 0
