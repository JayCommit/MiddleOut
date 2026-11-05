-- Migration 0007: Google Drive Mount and Agent MCP Support

-- External credentials for Cloud Providers (e.g., Google Drive)
create table if not exists mo_external_credentials (
  id text primary key,
  owner_id text not null,
  provider text not null,
  auth_type text not null default 'oauth',
  client_id text not null default '',
  client_secret text not null default '',
  access_token text not null default '',
  refresh_token text not null default '',
  token_expiry timestamptz,
  service_account_json text not null default '',
  metadata text not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, provider)
);
create index if not exists mo_external_credentials_owner_idx on mo_external_credentials (owner_id);

-- Extend buckets for external providers and ephemeral scratch buckets
alter table mo_buckets add column if not exists provider text not null default 'local';
alter table mo_buckets add column if not exists provider_config text not null default '{}';
alter table mo_buckets add column if not exists is_scratch boolean not null default false;
alter table mo_buckets add column if not exists expires_at timestamptz;

-- Agent tokens for AI / MCP authentication
create table if not exists mo_agent_tokens (
  id text primary key,
  owner_id text not null,
  token text not null unique,
  name text not null,
  permissions text not null default 'read-write',
  bucket_scope text not null default '*',
  expires_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists mo_agent_tokens_owner_idx on mo_agent_tokens (owner_id);
create index if not exists mo_agent_tokens_token_idx on mo_agent_tokens (token);
