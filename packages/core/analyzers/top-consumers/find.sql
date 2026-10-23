SELECT
  prefix,
  'info' AS severity,
  0 AS reclaimable_bytes,
  CAST(json_object('bytes', bytes, 'objects', objects) AS VARCHAR) AS details
FROM prefix_stats
WHERE bucket = $bucket
  AND prefix <> ''
  AND depth = 1
ORDER BY bytes DESC
LIMIT $limit
