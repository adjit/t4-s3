SELECT
  prefix,
  'medium' AS severity,
  bytes AS reclaimable_bytes,
  CAST(json_object('newest', newest, 'objects', objects, 'days', $days) AS VARCHAR) AS details
FROM prefix_stats
WHERE bucket = $bucket
  AND prefix <> ''
  AND objects > 0
  AND newest IS NOT NULL
  AND newest < current_timestamp - ($days * INTERVAL 1 DAY)
  AND depth = (
    SELECT min(shorter.depth)
    FROM prefix_stats AS shorter
    WHERE shorter.bucket = prefix_stats.bucket
      AND shorter.prefix <> ''
      AND shorter.objects > 0
      AND shorter.newest IS NOT NULL
      AND shorter.newest < current_timestamp - ($days * INTERVAL 1 DAY)
      AND starts_with(prefix_stats.prefix, shorter.prefix)
  )
