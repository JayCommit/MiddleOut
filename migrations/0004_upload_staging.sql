-- Pending console uploads coexist with the committed object until publication.
alter table mo_objects drop constraint if exists mo_objects_bucket_id_key_key;
create unique index if not exists mo_objects_committed_key on mo_objects (bucket_id, key) where complete = true;
