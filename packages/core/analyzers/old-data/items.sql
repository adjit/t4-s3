-- Latest deletes omit version_id so a versioned bucket writes a delete marker.
SELECT key, NULL::VARCHAR AS version_id, etag, last_modified, size, NULL::VARCHAR AS upload_id
FROM objects
WHERE bucket = $bucket
  AND is_latest
  AND NOT is_delete_marker
  AND starts_with(key, $prefix)
