"""Real-client compatibility suite. Credentials and endpoint come from disposable fixtures."""
import os, json, subprocess, tempfile, pathlib, urllib.request
import boto3
from botocore.config import Config
endpoint = os.environ["MIDDLEOUT_TEST_ENDPOINT"]
client = boto3.client("s3", endpoint_url=endpoint, config=Config(signature_version="s3v4", s3={"addressing_style": "path"}, request_checksum_calculation="when_required", response_checksum_validation="when_required"))
bucket = "interop-clients"
client.create_bucket(Bucket=bucket)
payload = b"Middle Out client compatibility\x00\xff"
client.put_object(Bucket=bucket, Key="folder/test file.txt", Body=payload, ContentType="application/octet-stream")
assert client.get_object(Bucket=bucket, Key="folder/test file.txt")["Body"].read() == payload
assert client.get_object(Bucket=bucket, Key="folder/test file.txt", Range="bytes=0-5")["Body"].read() == payload[:6]
assert client.head_object(Bucket=bucket, Key="folder/test file.txt")["ContentLength"] == len(payload)
client.copy_object(Bucket=bucket, Key="copied", CopySource={"Bucket": bucket, "Key": "folder/test file.txt"})
client.put_object_tagging(Bucket=bucket, Key="copied", Tagging={"TagSet":[{"Key":"client","Value":"boto3"}]})
assert client.get_object_tagging(Bucket=bucket, Key="copied")["TagSet"] == [{"Key":"client","Value":"boto3"}]
url = client.generate_presigned_url("get_object", Params={"Bucket":bucket,"Key":"copied"}, ExpiresIn=60)
assert urllib.request.urlopen(url).read() == payload
for key in ["page/a", "page/b", "page/c"]: client.put_object(Bucket=bucket, Key=key, Body=b"x")
pages = list(client.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix="page/", PaginationConfig={"PageSize":1}))
assert [o["Key"] for p in pages for o in p.get("Contents",[])] == ["page/a","page/b","page/c"]
mp = client.create_multipart_upload(Bucket=bucket, Key="multipart")
parts=[]
for number, data in [(1,b"a"*(5*1024*1024)),(2,b"b")]:
    result = client.upload_part(Bucket=bucket, Key="multipart", UploadId=mp["UploadId"], PartNumber=number, Body=data)
    parts.append({"PartNumber":number,"ETag":result["ETag"]})
client.complete_multipart_upload(Bucket=bucket, Key="multipart", UploadId=mp["UploadId"], MultipartUpload={"Parts":parts})
assert client.get_object(Bucket=bucket, Key="multipart")["Body"].read() == b"a"*(5*1024*1024)+b"b"
print("PASS: boto3 signing, bytes, ranges, head, copy, tags, presigned URLs, pagination and multipart")
with tempfile.TemporaryDirectory(prefix="middleout-client-") as tmp:
    source=pathlib.Path(tmp)/"source.bin"; target=pathlib.Path(tmp)/"download.bin"; source.write_bytes(payload)
    aws=[os.environ.get("PYTHON", "python"),"-m","awscli","--endpoint-url",endpoint]
    subprocess.run(aws+["s3","cp",str(source),f"s3://{bucket}/aws-cli"], check=True)
    subprocess.run(aws+["s3","cp",f"s3://{bucket}/aws-cli",str(target)], check=True)
    assert target.read_bytes()==payload
    listing=subprocess.check_output(aws+["s3api","list-objects-v2","--bucket",bucket,"--prefix","aws-cli"])
    assert json.loads(listing)["Contents"][0]["Key"] == "aws-cli"
    print("PASS: AWS CLI upload, download and listing")
    rclone=os.environ.get("RCLONE_BIN","rclone")
    remote=f":s3,provider=Other,env_auth=true,endpoint='{endpoint}',force_path_style=true:"
    subprocess.run([rclone,"copyto",str(source),remote+bucket+"/rclone", "--s3-no-check-bucket", "--s3-disable-checksum"],check=True)
    target.unlink()
    subprocess.run([rclone,"copyto",remote+bucket+"/rclone",str(target),"--s3-disable-checksum"],check=True)
    assert target.read_bytes()==payload
    print("PASS: rclone upload and download")
