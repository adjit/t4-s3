SELECT
  '' AS prefix,
  'low' AS severity,
  0 AS reclaimable_bytes,
  CAST(json_object('objects', count(*)) AS VARCHAR) AS details
FROM objects
WHERE bucket = $bucket
  AND is_latest
  AND NOT is_delete_marker
  AND (coalesce(size, 0) = 0 OR key LIKE '%/')
HAVING count(*) > 0
