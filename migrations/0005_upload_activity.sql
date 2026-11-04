alter table mo_multipart_uploads add column if not exists updated_at timestamptz not null default now();
create index if not exists mo_audit_owner_time_idx on mo_audit(owner_id, created_at desc, id desc);
