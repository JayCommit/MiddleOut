import assert from "node:assert/strict";
import { test } from "node:test";
import {
  saveDriveCredentials,
  getDriveCredentials,
  deleteDriveCredentials,
  resolveDriveFolder,
  findDriveFile,
  gdriveListObjects,
  gdriveGetObject,
  gdrivePutObject,
  gdriveDeleteObject,
} from "./gdrive.server.ts";
import {
  createBucket,
  browse,
  putBytes,
  readObjectFor,
  removeObject,
} from "./queries.server.ts";

test("Google Drive: credential persistence and deletion", async () => {
  const ownerId = "gdrive-test-user-1";
  await saveDriveCredentials(ownerId, {
    authType: "oauth",
    clientId: "test-client-id.apps.googleusercontent.com",
    clientSecret: "test-secret",
    refreshToken: "1//test-refresh-token",
    accessToken: "test-access-token",
    tokenExpiry: new Date(Date.now() + 3600000).toISOString(),
    metadata: { email: "drive-user@example.com" },
  });

  const creds = await getDriveCredentials(ownerId);
  assert.ok(creds, "Credentials should exist");
  assert.equal(creds.clientId, "test-client-id.apps.googleusercontent.com");
  assert.equal(creds.metadata.email, "drive-user@example.com");

  await deleteDriveCredentials(ownerId);
  const deleted = await getDriveCredentials(ownerId);
  assert.equal(deleted, null, "Credentials should be deleted");
});

test("Google Drive: mock folder resolution and file operations", async () => {
  const ownerId = "gdrive-test-user-2";
  await saveDriveCredentials(ownerId, {
    authType: "oauth",
    clientId: "cid",
    clientSecret: "sec",
    refreshToken: "tok",
    accessToken: "valid-tok",
    tokenExpiry: new Date(Date.now() + 3600000).toISOString(),
  });

  // Mock in-memory Google Drive state
  const mockFiles: Array<{
    id: string;
    name: string;
    parents: string[];
    mimeType: string;
    size?: string;
    content?: Buffer;
    md5Checksum?: string;
  }> = [
    {
      id: "folder-docs",
      name: "docs",
      parents: ["root-folder-id"],
      mimeType: "application/vnd.google-apps.folder",
    },
    {
      id: "file-1",
      name: "guide.txt",
      parents: ["folder-docs"],
      mimeType: "text/plain",
      size: "13",
      content: Buffer.from("Hello GDrive!"),
      md5Checksum: "mock-md5-1",
    },
  ];

  const mockFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const urlStr = input.toString();

    // Download file content (alt=media)
    if (urlStr.includes("alt=media")) {
      const fileId = urlStr.split("/drive/v3/files/")[1]?.split("?")[0];
      const found = mockFiles.find((f) => f.id === fileId);
      if (found && found.content) {
        return new Response(new Uint8Array(found.content), {
          status: 200,
          headers: { "Content-Type": found.mimeType },
        });
      }
      return new Response("Not found", { status: 404 });
    }

    // List files
    if (urlStr.includes("https://www.googleapis.com/drive/v3/files") && (!init?.method || init.method === "GET")) {
      const url = new URL(urlStr);
      const q = url.searchParams.get("q") || "";
      let matches = mockFiles;

      if (q.includes("'root-folder-id' in parents")) {
        matches = matches.filter((f) => f.parents.includes("root-folder-id"));
      } else if (q.includes("'folder-docs' in parents")) {
        matches = matches.filter((f) => f.parents.includes("folder-docs"));
      }

      if (q.includes("name = 'docs'")) {
        matches = matches.filter((f) => f.name === "docs");
      }
      if (q.includes("name = 'guide.txt'")) {
        matches = matches.filter((f) => f.name === "guide.txt");
      }
      if (q.includes("mimeType = 'application/vnd.google-apps.folder'")) {
        matches = matches.filter((f) => f.mimeType === "application/vnd.google-apps.folder");
      }
      if (q.includes("mimeType != 'application/vnd.google-apps.folder'")) {
        matches = matches.filter((f) => f.mimeType !== "application/vnd.google-apps.folder");
      }

      return new Response(JSON.stringify({ files: matches }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Upload / Create file
    if (urlStr.includes("upload/drive/v3/files")) {
      const newId = `file-${Date.now()}`;
      mockFiles.push({
        id: newId,
        name: "uploaded.txt",
        parents: ["folder-docs"],
        mimeType: "text/plain",
        size: "11",
        content: Buffer.from("Upload test"),
        md5Checksum: "md5-uploaded",
      });
      return new Response(JSON.stringify({ id: newId, md5Checksum: "md5-uploaded" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Delete file
    if (init?.method === "DELETE") {
      const fileId = urlStr.split("/drive/v3/files/")[1];
      const idx = mockFiles.findIndex((f) => f.id === fileId);
      if (idx !== -1) mockFiles.splice(idx, 1);
      return new Response(null, { status: 204 });
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  // Test folder resolution
  const resolvedFolderId = await resolveDriveFolder(
    "root-folder-id",
    "docs",
    false,
    "valid-tok",
    mockFetch,
  );
  assert.equal(resolvedFolderId, "folder-docs");

  // Test file location
  const foundFile = await findDriveFile("root-folder-id", "docs/guide.txt", "valid-tok", mockFetch);
  assert.ok(foundFile);
  assert.equal(foundFile.name, "guide.txt");

  // Test object read
  const obj = await gdriveGetObject("root-folder-id", "docs/guide.txt", ownerId, null, mockFetch);
  assert.ok(obj);
  assert.equal(obj.bytes.toString(), "Hello GDrive!");
  assert.equal(obj.contentType, "text/plain");

  // Test read-only mount restriction
  const putRoRes = await gdrivePutObject(
    "root-folder-id",
    "docs/new.txt",
    Buffer.from("Forbidden"),
    "text/plain",
    ownerId,
    "ro",
    mockFetch,
  );
  assert.equal(putRoRes.ok, false);
  assert.match(putRoRes.error || "", /Read-Only/);

  // Test read-write put
  const putRwRes = await gdrivePutObject(
    "root-folder-id",
    "docs/new.txt",
    Buffer.from("Upload test"),
    "text/plain",
    ownerId,
    "rw",
    mockFetch,
  );
  assert.equal(putRwRes.ok, true);

  // Test delete in read-only mode
  const delRoRes = await gdriveDeleteObject(
    "root-folder-id",
    "docs/guide.txt",
    ownerId,
    "ro",
    mockFetch,
  );
  assert.equal(delRoRes.ok, false);

  // Test delete in read-write mode
  const delRwRes = await gdriveDeleteObject(
    "root-folder-id",
    "docs/guide.txt",
    ownerId,
    "rw",
    mockFetch,
  );
  assert.equal(delRwRes.ok, true);
});

test("Google Drive: bucket mapping creation and transparent routing", async () => {
  const ownerId = "gdrive-mount-owner";
  await saveDriveCredentials(ownerId, {
    authType: "oauth",
    clientId: "cid",
    clientSecret: "sec",
    refreshToken: "tok",
    accessToken: "valid-tok",
    tokenExpiry: new Date(Date.now() + 3600000).toISOString(),
  });

  const bucketName = "gdrive-mounted-bucket";
  const createRes = await createBucket(ownerId, bucketName, "private", {
    provider: "gdrive",
    providerConfig: { folderId: "my-gdrive-folder-123", mountMode: "rw" },
  });

  assert.equal(createRes.ok, true);
  assert.equal(createRes.provider, "gdrive");

  // Verify browse shows provider information
  const browseRes = await browse(ownerId, bucketName, "");
  assert.equal(browseRes.ok, true);
  if (browseRes.ok) {
    assert.equal(browseRes.bucket.provider, "gdrive");
    assert.equal(browseRes.bucket.providerConfig?.folderId, "my-gdrive-folder-123");
  }
});
