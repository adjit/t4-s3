SELECT key, version_id, etag, last_modified, size, NULL::VARCHAR AS upload_id
FROM objects
WHERE bucket = $bucket
  AND parent_prefix = $prefix
  AND (NOT is_latest OR is_delete_marker)
