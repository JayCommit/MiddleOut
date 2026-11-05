create table if not exists mo_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

alter table mo_buckets add column if not exists acl text not null default 'private';
alter table mo_objects add column if not exists acl text not null default 'private';

-- Sync existing public buckets to have acl = 'public-read'
update mo_buckets set acl = 'public-read' where is_public = true and acl = 'private';
