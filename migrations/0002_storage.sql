create table if not exists mo_accounts (
  owner_id text primary key,
  region text not null default 'us-east-1',
  seeded boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists mo_buckets (
  id text primary key,
  owner_id text not null,
  name text not null unique,
  is_public boolean not null default false,
  region text not null default 'us-east-1',
  created_at timestamptz not null default now()
);
create index if not exists mo_buckets_owner_idx on mo_buckets (owner_id);

create table if not exists mo_objects (
  id text primary key,
  bucket_id text not null references mo_buckets (id) on delete cascade,
  key text not null,
  size integer not null,
  content_type text not null,
  etag text not null default '',
  complete boolean not null default false,
  headers text not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (bucket_id, key)
);
create index if not exists mo_objects_bucket_key_idx on mo_objects (bucket_id, key);

create table if not exists mo_parts (
  object_id text not null references mo_objects (id) on delete cascade,
  part integer not null,
  data text not null,
  primary key (object_id, part)
);

create table if not exists mo_tags (
  object_id text not null references mo_objects (id) on delete cascade,
  tag_key text not null,
  tag_value text not null,
  primary key (object_id, tag_key)
);

create table if not exists mo_keys (
  id text primary key,
  owner_id text not null,
  access_key_id text not null unique,
  secret_key text not null,
  secret_last4 text not null,
  label text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists mo_keys_owner_idx on mo_keys (owner_id);

create table if not exists mo_audit (
  id text primary key,
  owner_id text not null,
  action text not null,
  detail text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists mo_audit_owner_idx on mo_audit (owner_id, created_at desc);

create table if not exists mo_links (
  token text primary key,
  object_id text not null references mo_objects (id) on delete cascade,
  owner_id text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
