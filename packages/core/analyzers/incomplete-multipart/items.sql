SELECT key, NULL::VARCHAR AS version_id, NULL::VARCHAR AS etag, initiated AS last_modified, parts_bytes AS size, upload_id
FROM multipart_uploads
WHERE bucket = $bucket
