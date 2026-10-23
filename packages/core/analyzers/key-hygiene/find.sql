WITH bad AS (
  SELECT key
  FROM objects
  WHERE bucket = $bucket
    AND is_latest
    AND NOT is_delete_marker
    AND (
      key LIKE '% %'
      OR key LIKE '%//%'
      OR length(key) > $max_length
      OR regexp_matches(key, '[[:cntrl:]]')
    )
  UNION
  SELECT min(key) AS key
  FROM objects
  WHERE bucket = $bucket
    AND is_latest
    AND NOT is_delete_marker
  GROUP BY lower(key)
  HAVING count(DISTINCT key) > 1
)
SELECT
  '' AS prefix,
  'low' AS severity,
  0 AS reclaimable_bytes,
  CAST(json_object('count', count(*), 'samples', list_slice(list(key), 1, 10)) AS VARCHAR) AS details
FROM bad
HAVING count(*) > 0
