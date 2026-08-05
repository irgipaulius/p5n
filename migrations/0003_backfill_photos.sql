-- Backfill photo_count from detail_json where scrapes stored nb_photos before column existed
UPDATE places
SET photo_count = (
  SELECT CAST(json_extract(d.payload_json, '$.nb_photos') AS INTEGER)
  FROM place_details d
  WHERE d.place_id = places.place_id
)
WHERE photo_count = 0
  AND EXISTS (
    SELECT 1 FROM place_details d2
    WHERE d2.place_id = places.place_id
      AND CAST(json_extract(d2.payload_json, '$.nb_photos') AS INTEGER) > 0
  );
