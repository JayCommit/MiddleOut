# Security

Supported release: the latest tagged release. Keep your node and dependencies updated.

Report suspected vulnerabilities privately through this repository's GitHub private vulnerability reporting feature. Do not include live credentials or private object contents in public issues. If private reporting is unavailable, ask the maintainer for a private reporting channel without publishing exploit details.

Run behind HTTPS for internet access. Registration is disabled by default: enable it only while creating intended accounts, then disable it and restart. Bucket names are global within a node. Each account owns its own buckets; scoped keys must authorize both source and destination operations. Treat every uploaded object as untrusted content. Object responses enforce a sandbox and nosniff, and active documents download as attachments.

Use one process with embedded storage. Mount persistent writable DATA_DIR storage. External Postgres requires a persistent BETTER_AUTH_SECRET. Never expose database ports publicly. The metrics endpoint exposes node-wide counts and process statistics; restrict it at the reverse proxy if those are private.

IAM policies and signed aws-chunked payloads are unsupported and rejected. Do not use this release for workloads requiring versioning, object lock, or encryption at rest supplied by the application. Protect your disks and backups at the host/database layer.
