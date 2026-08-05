-- p5n v2.1: photo_count + corrected p4n attribute field mappings

ALTER TABLE places ADD COLUMN photo_count INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_places_rating ON places(rating);
CREATE INDEX IF NOT EXISTS idx_places_photos ON places(photo_count);

UPDATE attribute_defs SET source_mappings = '{"p4n":"wifi"}' WHERE key = 'wifi';
UPDATE attribute_defs SET source_mappings = '{"p4n":"douche"}' WHERE key = 'douche';
UPDATE attribute_defs SET source_mappings = '{"p4n":"electricite"}' WHERE key = 'electricite';
UPDATE attribute_defs SET source_mappings = '{"p4n":"animaux"}' WHERE key = 'animaux';
UPDATE attribute_defs SET source_mappings = '{"p4n":"point_eau"}' WHERE key = 'eau';
UPDATE attribute_defs SET source_mappings = '{"p4n":"baignade"}' WHERE key = 'baignade';
UPDATE attribute_defs SET source_mappings = '{"p4n":"poubelle"}' WHERE key = 'poubelle';
UPDATE attribute_defs SET source_mappings = '{"p4n":"wc_public"}' WHERE key = 'wc';
UPDATE attribute_defs SET source_mappings = '{"p4n":"caravaneige"}' WHERE key = 'parking';
UPDATE attribute_defs SET source_mappings = '{"p4n":"piscine"}' WHERE key = 'piscine';
UPDATE attribute_defs SET source_mappings = '{"p4n":"laverie"}' WHERE key = 'laverie';
UPDATE attribute_defs SET source_mappings = '{"p4n":"gaz"}' WHERE key = 'gaz';
UPDATE attribute_defs SET source_mappings = '{"p4n":"donnees_mobile"}' WHERE key = 'donnees';
UPDATE attribute_defs SET source_mappings = '{"p4n":"acces_handi"}' WHERE key = 'acces_handi';
UPDATE attribute_defs SET source_mappings = '{"p4n":"bbq"}' WHERE key = 'bbq';
UPDATE attribute_defs SET source_mappings = '{"p4n":"poussette"}' WHERE key = 'poussette';
UPDATE attribute_defs SET source_mappings = '{"p4n":"rando"}' WHERE key = 'sport';
UPDATE attribute_defs SET source_mappings = '{"p4n":"jeux_enfants"}' WHERE key = 'jeux';
UPDATE attribute_defs SET source_mappings = '{"p4n":"restaurant"}' WHERE key = 'restaurant';
UPDATE attribute_defs SET source_mappings = '{"p4n":"boulangerie"}' WHERE key = 'boulangerie';
UPDATE attribute_defs SET source_mappings = '{"p4n":"supermarche"}' WHERE key = 'supermarche';
UPDATE attribute_defs SET source_mappings = '{"p4n":"pharmacie"}' WHERE key = 'pharmacie';
UPDATE attribute_defs SET source_mappings = '{"p4n":"lavage"}' WHERE key = 'laverie_auto';
UPDATE attribute_defs SET source_mappings = '{"p4n":"vtt"}' WHERE key = 'piste';
UPDATE attribute_defs SET source_mappings = '{"p4n":"peche"}' WHERE key = 'peche';
UPDATE attribute_defs SET source_mappings = '{"p4n":"vtt"}' WHERE key = 'velo';
UPDATE attribute_defs SET source_mappings = '{"p4n":"ski"}' WHERE key = 'ski';
UPDATE attribute_defs SET source_mappings = '{"p4n":"plongee"}' WHERE key = 'plongee';
UPDATE attribute_defs SET source_mappings = '{"p4n":"location"}' WHERE key = 'location';
UPDATE attribute_defs SET source_mappings = '{"p4n":"visites"}' WHERE key = 'visite';
UPDATE attribute_defs SET source_mappings = '{"p4n":"camping"}' WHERE key = 'camping';
UPDATE attribute_defs SET source_mappings = '{"p4n":"naturiste"}' WHERE key = 'naturiste';
