SELECT
  '' AS prefix,
  'medium' AS severity,
  coalesce(sum(parts_bytes), 0) AS reclaimable_bytes,
  CAST(json_object('uploads', count(*)) AS VARCHAR) AS details
FROM multipart_uploads
WHERE bucket = $bucket
HAVING count(*) > 0
