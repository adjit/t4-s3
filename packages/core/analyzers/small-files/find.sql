SELECT
  parent_prefix AS prefix,
  'low' AS severity,
  0 AS reclaimable_bytes,
  CAST(json_object('objects', count(*), 'median_size', median(size), 'bytes', coalesce(sum(size), 0)) AS VARCHAR) AS details
FROM objects
WHERE bucket = $bucket
  AND is_latest
  AND NOT is_delete_marker
  AND parent_prefix <> ''
GROUP BY parent_prefix
HAVING count(*) > $min_count AND median(size) < $max_median
