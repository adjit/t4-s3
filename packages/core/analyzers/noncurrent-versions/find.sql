SELECT
  parent_prefix AS prefix,
  'medium' AS severity,
  coalesce(sum(size) FILTER (WHERE NOT is_delete_marker), 0) AS reclaimable_bytes,
  CAST(json_object(
    'versions', count(*) FILTER (WHERE NOT is_delete_marker),
    'delete_markers', count(*) FILTER (WHERE is_delete_marker)
  ) AS VARCHAR) AS details
FROM objects
WHERE bucket = $bucket
  AND (NOT is_latest OR is_delete_marker)
GROUP BY parent_prefix
HAVING count(*) > 0
