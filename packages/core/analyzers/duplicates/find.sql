WITH groups AS (
  SELECT
    size,
    etag,
    count(*) AS copies,
    sum(size) AS total_bytes,
    min(key) AS keep_key
  FROM objects
  WHERE bucket = $bucket
    AND is_latest
    AND NOT is_delete_marker
    AND NOT coalesce(is_multipart, false)
    AND etag IS NOT NULL
    AND size > 0
  GROUP BY size, etag
  HAVING count(*) > 1
)
SELECT
  regexp_replace(keep_key, '[^/]*$', '') AS prefix,
  'medium' AS severity,
  (total_bytes - size) AS reclaimable_bytes,
  CAST(json_object('size', size, 'etag', etag, 'copies', copies, 'keep_key', keep_key) AS VARCHAR) AS details
FROM groups
