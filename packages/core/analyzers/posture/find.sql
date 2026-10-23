SELECT
  parent_prefix AS prefix,
  'high' AS severity,
  0 AS reclaimable_bytes,
  CAST(json_object('objects', count(*)) AS VARCHAR) AS details
FROM objects
WHERE bucket = $bucket
  AND is_latest
  AND NOT is_delete_marker
  AND encryption = 'NONE'
GROUP BY parent_prefix
HAVING count(*) > 0
