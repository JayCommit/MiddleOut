import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Shell } from "@/components/shell";
import { PageHeader } from "@/components/ui";
import { s3Endpoint } from "@/lib/storage/paths";

export const Route = createFileRoute("/docs")({ component: DocsPage });

const ROWS = [
  ["ListBuckets / Create / Delete / Head", "Yes"],
  ["GetBucketLocation and bucket ACL", "Yes"],
  ["PutObject / GetObject / Head / Delete / Copy", "Yes"],
  ["ListObjects and ListObjectsV2", "Yes, prefix, delimiter, max-keys"],
  ["Range and If-Match / If-None-Match", "Yes"],
  ["AWS SigV4 and presigned query URLs", "Yes"],
  ["Authorization: MO key:secret", "Yes, for curl"],
  ["aws-chunked request bodies", "Yes"],
  ["Public-read buckets", "Yes"],
  ["Multipart upload API", "No. Single PUT up to 8 MB"],
  ["Versioning, object lock, lifecycle, SSE", "No"],
  ["Virtual-hosted bucket DNS", "No. Path-style only"],
];

function DocsPage() {
  const [endpoint, setEndpoint] = useState("/api/s3");
  useEffect(() => setEndpoint(s3Endpoint()), []);
  return (
    <Shell>
      <PageHeader
        title="Docs"
        description="Point an S3 client at this node. Create an access key first. Private buckets reject anonymous calls."
      />
      <div className="mt-6 flex max-w-3xl flex-col gap-6">
        <section className="rounded-lg border border-border bg-surface p-4">
          <h2 className="text-sm font-medium">Endpoint</h2>
          <p className="mt-2 break-all font-mono text-xs">{endpoint}</p>
        </section>
        <section>
          <h2 className="text-sm font-medium">AWS CLI</h2>
          <pre className="mt-2 overflow-auto rounded-lg border border-border bg-surface p-4 font-mono text-xs leading-relaxed">{`export AWS_ACCESS_KEY_ID=MO...
export AWS_SECRET_ACCESS_KEY=...
export AWS_DEFAULT_REGION=us-east-1
export AWS_REQUEST_CHECKSUM_CALCULATION=when_required
export AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
aws s3 mb s3://photos --endpoint-url ${endpoint}
aws s3 cp ./notes.txt s3://photos/notes.txt --endpoint-url ${endpoint}
aws s3 ls s3://photos --endpoint-url ${endpoint}`}</pre>
        </section>
        <section>
          <h2 className="text-sm font-medium">curl</h2>
          <pre className="mt-2 overflow-auto rounded-lg border border-border bg-surface p-4 font-mono text-xs leading-relaxed">{`curl -H "Authorization: MO $AWS_ACCESS_KEY_ID:$AWS_SECRET_ACCESS_KEY" \\
  ${endpoint}/photos/notes.txt --upload-file notes.txt
curl ${endpoint.replace(/\/api\/s3$/, "")}/api/health`}</pre>
        </section>
        <section>
          <h2 className="text-sm font-medium">rclone</h2>
          <pre className="mt-2 overflow-auto rounded-lg border border-border bg-surface p-4 font-mono text-xs leading-relaxed">{`[middleout]
type = s3
provider = Other
access_key_id = MO...
secret_access_key = ...
endpoint = ${endpoint}
force_path_style = true`}</pre>
        </section>
        <section>
          <h2 className="text-sm font-medium">Compatibility</h2>
          <div className="mt-2 overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[28rem] text-left text-sm">
              <thead className="bg-surface text-xs text-muted">
                <tr>
                  <th className="px-4 py-3 font-medium">Operation</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {ROWS.map((row) => (
                  <tr key={row[0]} className="border-t border-border">
                    <td className="px-4 py-3">{row[0]}</td>
                    <td className="px-4 py-3 text-muted">{row[1]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </Shell>
  );
}
