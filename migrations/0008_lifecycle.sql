-- Lifecycle age tracks publication, independently of ACL or tag edits.
alter table mo_objects add column if not exists written_at timestamptz;
update mo_objects set written_at = updated_at where written_at is null;
alter table mo_objects alter column written_at set default now();
alter table mo_objects alter column written_at set not null;
create index if not exists mo_objects_lifecycle_idx on mo_objects (bucket_id, written_at) where complete = true;

create table if not exists mo_bucket_lifecycle (
  bucket_id text primary key references mo_buckets(id) on delete cascade,
  configuration text not null,
  revision text not null,
  updated_at timestamptz not null default now(),
  last_evaluated_at timestamptz,
  last_error text,
  expired_objects bigint not null default 0,
  expired_bytes bigint not null default 0,
  aborted_uploads bigint not null default 0
);
create index if not exists mo_lifecycle_schedule_idx on mo_bucket_lifecycle (last_evaluated_at nulls first, bucket_id);
