create table if not exists mo_multipart_uploads (
  id text primary key,
  bucket_id text not null references mo_buckets (id) on delete cascade,
  key text not null,
  owner_id text not null,
  content_type text not null default 'application/octet-stream',
  headers text not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists mo_multipart_bucket_idx on mo_multipart_uploads (bucket_id);
create index if not exists mo_multipart_owner_idx on mo_multipart_uploads (owner_id);

create table if not exists mo_multipart_parts (
  upload_id text not null references mo_multipart_uploads (id) on delete cascade,
  part_number integer not null,
  size integer not null default 0,
  etag text not null,
  data text not null,
  created_at timestamptz not null default now(),
  primary key (upload_id, part_number)
);

alter table mo_keys add column if not exists permission text not null default 'full';
alter table mo_keys add column if not exists bucket_scope text;

alter table mo_buckets add column if not exists cors_rules text not null default '[]';
alter table mo_buckets add column if not exists policy text;
