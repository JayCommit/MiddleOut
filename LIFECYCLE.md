# Bucket lifecycle rules

Lifecycle rules automatically expire files and abort unfinished S3 multipart uploads in **local buckets**. Use them for logs, exports, build artifacts, and other data with a retention period. No rules are installed by default.

## Use the console

1. Open a bucket and select **Lifecycle**.
2. Select **Create rule**, enter a name and optional file prefix, and choose an expiration age or UTC date. You can also set an unfinished-upload age.
3. Optionally add tag and size filters. Every condition must match. Incomplete-upload rules support prefixes only; use a separate rule when expiring files by tags or size.
4. Select **Review rule**, then **Preview affected files**. The preview shows eligible file/upload counts, bytes, and a sample of up to 20 files without changing data.
5. Acknowledge permanent deletion and save. Saving schedules the rule; it does not delete files immediately.

You can edit, disable, enable, or delete rules. **Run cleanup** previews the saved configuration before executing one bounded pass. Removing or disabling a rule stops future deletions; it does not restore previously deleted files. Concurrent edits are detected: reload the rules if another client has changed them.

The panel shows the last evaluation, failed evaluations, and totals for expired files, their bytes, and aborted uploads. Totals belong to the current configuration and reset when the entire configuration is deleted. Activity records identify individual expired keys and aborted uploads.

## Use an S3 client

Create an access key, then save this as `lifecycle.json`:

```json
{
  "Rules": [
    {
      "ID": "expire-old-logs",
      "Status": "Enabled",
      "Filter": { "Prefix": "logs/" },
      "Expiration": { "Days": 30 }
    },
    {
      "ID": "abort-unfinished-uploads",
      "Status": "Enabled",
      "Filter": {},
      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 7 }
    }
  ]
}
```

```bash
aws --endpoint-url "$ORIGIN/api/s3" s3api put-bucket-lifecycle-configuration \
  --bucket logs --lifecycle-configuration file://lifecycle.json
aws --endpoint-url "$ORIGIN/api/s3" s3api get-bucket-lifecycle-configuration --bucket logs
aws --endpoint-url "$ORIGIN/api/s3" s3api delete-bucket-lifecycle --bucket logs
```

The same operations work with boto3's `put_bucket_lifecycle_configuration`, `get_bucket_lifecycle_configuration`, and `delete_bucket_lifecycle`. A PUT replaces the entire configuration atomically. GET returns `NoSuchLifecycleConfiguration` when none is configured. Deleting the configuration is idempotent and does not delete the bucket or its files.

The bucket owner can read and manage the configuration. Read-only access keys can read it; modifying it requires a full key. Bucket-scoped keys retain their restrictions, and public bucket access does not expose configuration.

## Supported rules

- Up to **1,000 rules per bucket**, with unique IDs and `Enabled` or `Disabled` status. Configuration size is limited to 512 KiB.
- `Expiration.Days`: positive whole days, up to 365,000.
- `Expiration.Date`: a valid ISO 8601 date at midnight UTC, such as `2030-01-01T00:00:00Z`. Use either Days or Date in one rule.
- `AbortIncompleteMultipartUpload.DaysAfterInitiation`: positive whole days, up to 365,000.
- `Filter.Prefix`, `Filter.Tag`, `Filter.ObjectSizeGreaterThan`, and `Filter.ObjectSizeLessThan`. Combine multiple conditions in `Filter.And`. Multiple tags use repeated XML `Tag` elements (or the standard `Tags` array in an AWS client).
- Empty `Filter` matches the whole bucket. Legacy top-level `Prefix` is also accepted.

Tag values and prefixes are case-sensitive and preserved literally, including spaces, Unicode, percent signs, and underscores. Size boundaries are exclusive. Overlapping rules do not double-count or delete an object twice; the earliest eligible expiration wins. S3 GET/HEAD includes `x-amz-expiration` for matching enabled rules.

Versioning actions, expired delete markers, and storage-class transitions are unsupported and return HTTP 501. Invalid or unrecognized filters are rejected instead of broadening a deletion rule. Google Drive mounts reject lifecycle configuration with HTTP 501; this scheduler never deletes provider files.

## Timing and execution

Age-based file expiry uses the content's publication time, adds the retention days, and rounds up to midnight UTC. For example, a file written on January 15 at 10:30 UTC with three-day retention becomes eligible on January 19 at 00:00 UTC. Overwrites, copies, moves to a new key, and completed uploads start a new lifetime. Changing ACLs or tags does not extend it. Pending console uploads are excluded from file expiration.

A date-based rule applies to every matching file once that date passes, including files uploaded later. Disable or remove it when you no longer want that behavior. Incomplete-upload expiry measures elapsed days since initiation, independently of recent part activity, and removes stored parts along with the upload record. Completed files are unaffected by an abort-only rule.

The production maintenance loop checks hourly by default. Set `MAINTENANCE_INTERVAL_SECONDS` between 60 and 86,400 to change the interval. It processes up to 25 buckets per pass, oldest evaluation first, and up to 200 expired files plus 200 unfinished uploads per bucket. Backlogs drain across passes; eligible files remain readable until deleted. A restart retains rules, counters, and remaining work, and evaluation resumes on the next maintenance tick.

The existing safety cleanup for uploads inactive for 24 hours still runs separately and can remove abandoned uploads earlier than a longer lifecycle age. Removing a configuration does not disable that safety cleanup. Buckets carrying unsupported legacy bucket policies are skipped until the policy is removed.

Deletion uses the same account lock as writes and tag changes. Metadata, stored parts, tags, share links, counters, and activity records commit in one transaction. Failed passes roll back and record a failure while other buckets continue. Expired data releases account quota; the database manages reuse or reclamation of its physical disk space.

## Why this feature

Users of [MinIO](https://github.com/minio/minio/issues/21537) and [RustFS](https://github.com/rustfs/rustfs/issues/1665) describe operational problems when retention does not reliably remove accumulated data. Middle Out implements the non-versioned expiration and upload-abort actions, following the [S3 lifecycle configuration model](https://docs.aws.amazon.com/AmazonS3/latest/userguide/intro-lifecycle-rules.html) and [incomplete-upload semantics](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpu-abort-incomplete-mpu-lifecycle-config.html).
