SELECT
  t.location AS prefix,
  'low' AS severity,
  0 AS reclaimable_bytes,
  CAST(json_object(
    'small_files', count(*) FILTER (WHERE o.size < 16777216),
    'objects', count(*),
    'bytes', coalesce(sum(o.size), 0)
  ) AS VARCHAR) AS details
FROM iceberg_tables AS t
JOIN objects AS o
  ON o.bucket = t.bucket
 AND starts_with(o.key, t.location)
WHERE t.bucket = $bucket
  AND o.is_latest
  AND NOT o.is_delete_marker
GROUP BY t.location
HAVING count(*) FILTER (WHERE o.size < 16777216) > 0
