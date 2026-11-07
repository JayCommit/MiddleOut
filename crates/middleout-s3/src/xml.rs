use crate::error::S3Error;
use crate::sigv4::s3_uri_encode;
use chrono::{DateTime, Utc};
use middleout_storage::{
    BucketInfo, CompletedPart, ListObjectsV2Output, MultipartUploadInfo, ObjectMeta, PartInfo,
};
use quick_xml::Reader;
use quick_xml::events::Event;

const XML_HEADER: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n";
const S3_NS: &str = "http://s3.amazonaws.com/doc/2006-03-01/";

/// Escapes XML special characters (`&`, `<`, `>`, `"`, `'`).
pub fn escape_xml(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(ch),
        }
    }
    out
}

/// Formats a UTC timestamp in S3 ISO-8601 format (`YYYY-MM-DDTHH:MM:SS.sssZ`).
pub fn format_s3_timestamp(dt: &DateTime<Utc>) -> String {
    dt.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

fn ensure_quoted_etag(etag: &str) -> String {
    let trimmed = etag.trim_matches('"');
    format!("\"{}\"", escape_xml(trimmed))
}

fn encode_key_or_prefix(val: &str, encoding_type_url: bool) -> String {
    if encoding_type_url {
        escape_xml(&s3_uri_encode(val, false))
    } else {
        escape_xml(val)
    }
}

fn encode_delimiter(val: &str, encoding_type_url: bool) -> String {
    if encoding_type_url {
        escape_xml(&s3_uri_encode(val, true))
    } else {
        escape_xml(val)
    }
}

pub fn render_error(err: &S3Error) -> String {
    let mut xml = String::from(XML_HEADER);
    xml.push_str("<Error>");
    xml.push_str(&format!("<Code>{}</Code>", escape_xml(err.code)));
    xml.push_str(&format!("<Message>{}</Message>", escape_xml(&err.message)));
    if let Some(ref res) = err.resource {
        xml.push_str(&format!("<Resource>{}</Resource>", escape_xml(res)));
    }
    xml.push_str(&format!(
        "<RequestId>{}</RequestId>",
        escape_xml(&err.request_id)
    ));
    xml.push_str("</Error>");
    xml
}

pub fn render_list_buckets(buckets: &[BucketInfo]) -> String {
    let mut xml = String::from(XML_HEADER);
    xml.push_str(&format!(
        "<ListAllMyBucketsResult xmlns=\"{S3_NS}\"><Owner><ID>middleout</ID><DisplayName>middleout</DisplayName></Owner><Buckets>"
    ));
    for b in buckets {
        xml.push_str("<Bucket>");
        xml.push_str(&format!("<Name>{}</Name>", escape_xml(&b.name)));
        xml.push_str(&format!(
            "<CreationDate>{}</CreationDate>",
            format_s3_timestamp(&b.created_at)
        ));
        xml.push_str("</Bucket>");
    }
    xml.push_str("</Buckets></ListAllMyBucketsResult>");
    xml
}

pub fn render_list_objects_v2(out: &ListObjectsV2Output, encoding_type_url: bool) -> String {
    let mut xml = String::from(XML_HEADER);
    xml.push_str(&format!("<ListBucketResult xmlns=\"{S3_NS}\">"));
    xml.push_str(&format!("<Name>{}</Name>", escape_xml(&out.name)));
    xml.push_str(&format!(
        "<Prefix>{}</Prefix>",
        encode_key_or_prefix(&out.prefix, encoding_type_url)
    ));
    xml.push_str(&format!("<KeyCount>{}</KeyCount>", out.key_count));
    xml.push_str(&format!("<MaxKeys>{}</MaxKeys>", out.max_keys));
    if let Some(ref delim) = out.delimiter {
        xml.push_str(&format!(
            "<Delimiter>{}</Delimiter>",
            encode_delimiter(delim, encoding_type_url)
        ));
    }
    if encoding_type_url {
        xml.push_str("<EncodingType>url</EncodingType>");
    }
    xml.push_str(&format!("<IsTruncated>{}</IsTruncated>", out.is_truncated));
    if let Some(ref token) = out.continuation_token {
        xml.push_str(&format!(
            "<ContinuationToken>{}</ContinuationToken>",
            escape_xml(token)
        ));
    }
    if let Some(ref next_token) = out.next_continuation_token {
        xml.push_str(&format!(
            "<NextContinuationToken>{}</NextContinuationToken>",
            escape_xml(next_token)
        ));
    }
    if let Some(ref start_after) = out.start_after {
        xml.push_str(&format!(
            "<StartAfter>{}</StartAfter>",
            encode_key_or_prefix(start_after, encoding_type_url)
        ));
    }

    for obj in &out.contents {
        xml.push_str("<Contents>");
        xml.push_str(&format!(
            "<Key>{}</Key>",
            encode_key_or_prefix(&obj.key, encoding_type_url)
        ));
        xml.push_str(&format!(
            "<LastModified>{}</LastModified>",
            format_s3_timestamp(&obj.updated_at)
        ));
        xml.push_str(&format!("<ETag>{}</ETag>", ensure_quoted_etag(&obj.etag)));
        xml.push_str(&format!("<Size>{}</Size>", obj.size));
        xml.push_str("<StorageClass>STANDARD</StorageClass>");
        xml.push_str("</Contents>");
    }

    for cp in &out.common_prefixes {
        xml.push_str("<CommonPrefixes>");
        xml.push_str(&format!(
            "<Prefix>{}</Prefix>",
            encode_key_or_prefix(cp, encoding_type_url)
        ));
        xml.push_str("</CommonPrefixes>");
    }

    xml.push_str("</ListBucketResult>");
    xml
}

pub fn render_list_objects_v1(
    out: &ListObjectsV2Output,
    marker: Option<&str>,
    next_marker: Option<&str>,
    encoding_type_url: bool,
) -> String {
    let mut xml = String::from(XML_HEADER);
    xml.push_str(&format!("<ListBucketResult xmlns=\"{S3_NS}\">"));
    xml.push_str(&format!("<Name>{}</Name>", escape_xml(&out.name)));
    xml.push_str(&format!(
        "<Prefix>{}</Prefix>",
        encode_key_or_prefix(&out.prefix, encoding_type_url)
    ));
    let marker_str = marker.unwrap_or("");
    xml.push_str(&format!(
        "<Marker>{}</Marker>",
        encode_key_or_prefix(marker_str, encoding_type_url)
    ));
    if let Some(nm) = next_marker.or(out.next_continuation_token.as_deref())
        && out.is_truncated
    {
        xml.push_str(&format!(
            "<NextMarker>{}</NextMarker>",
            encode_key_or_prefix(nm, encoding_type_url)
        ));
    }
    xml.push_str(&format!("<MaxKeys>{}</MaxKeys>", out.max_keys));
    if let Some(ref delim) = out.delimiter {
        xml.push_str(&format!(
            "<Delimiter>{}</Delimiter>",
            encode_delimiter(delim, encoding_type_url)
        ));
    }
    if encoding_type_url {
        xml.push_str("<EncodingType>url</EncodingType>");
    }
    xml.push_str(&format!("<IsTruncated>{}</IsTruncated>", out.is_truncated));

    for obj in &out.contents {
        xml.push_str("<Contents>");
        xml.push_str(&format!(
            "<Key>{}</Key>",
            encode_key_or_prefix(&obj.key, encoding_type_url)
        ));
        xml.push_str(&format!(
            "<LastModified>{}</LastModified>",
            format_s3_timestamp(&obj.updated_at)
        ));
        xml.push_str(&format!("<ETag>{}</ETag>", ensure_quoted_etag(&obj.etag)));
        xml.push_str(&format!("<Size>{}</Size>", obj.size));
        xml.push_str("<StorageClass>STANDARD</StorageClass>");
        xml.push_str("</Contents>");
    }

    for cp in &out.common_prefixes {
        xml.push_str("<CommonPrefixes>");
        xml.push_str(&format!(
            "<Prefix>{}</Prefix>",
            encode_key_or_prefix(cp, encoding_type_url)
        ));
        xml.push_str("</CommonPrefixes>");
    }

    xml.push_str("</ListBucketResult>");
    xml
}

pub fn render_initiate_multipart_upload(info: &MultipartUploadInfo) -> String {
    let mut xml = String::from(XML_HEADER);
    xml.push_str(&format!(
        "<InitiateMultipartUploadResult xmlns=\"{S3_NS}\">"
    ));
    xml.push_str(&format!("<Bucket>{}</Bucket>", escape_xml(&info.bucket)));
    xml.push_str(&format!("<Key>{}</Key>", escape_xml(&info.key)));
    xml.push_str(&format!(
        "<UploadId>{}</UploadId>",
        escape_xml(&info.upload_id)
    ));
    xml.push_str("</InitiateMultipartUploadResult>");
    xml
}

pub fn render_complete_multipart_upload(location: &str, meta: &ObjectMeta) -> String {
    let mut xml = String::from(XML_HEADER);
    xml.push_str(&format!(
        "<CompleteMultipartUploadResult xmlns=\"{S3_NS}\">"
    ));
    xml.push_str(&format!("<Location>{}</Location>", escape_xml(location)));
    xml.push_str(&format!("<Bucket>{}</Bucket>", escape_xml(&meta.bucket)));
    xml.push_str(&format!("<Key>{}</Key>", escape_xml(&meta.key)));
    xml.push_str(&format!("<ETag>{}</ETag>", ensure_quoted_etag(&meta.etag)));
    xml.push_str("</CompleteMultipartUploadResult>");
    xml
}

pub fn render_list_parts(info: &MultipartUploadInfo, parts: &[PartInfo]) -> String {
    let mut xml = String::from(XML_HEADER);
    xml.push_str(&format!("<ListPartsResult xmlns=\"{S3_NS}\">"));
    xml.push_str(&format!("<Bucket>{}</Bucket>", escape_xml(&info.bucket)));
    xml.push_str(&format!("<Key>{}</Key>", escape_xml(&info.key)));
    xml.push_str(&format!(
        "<UploadId>{}</UploadId>",
        escape_xml(&info.upload_id)
    ));
    xml.push_str("<StorageClass>STANDARD</StorageClass>");
    xml.push_str("<IsTruncated>false</IsTruncated>");
    for p in parts {
        xml.push_str("<Part>");
        xml.push_str(&format!("<PartNumber>{}</PartNumber>", p.part_number));
        xml.push_str(&format!(
            "<LastModified>{}</LastModified>",
            format_s3_timestamp(&p.updated_at)
        ));
        xml.push_str(&format!("<ETag>{}</ETag>", ensure_quoted_etag(&p.etag)));
        xml.push_str(&format!("<Size>{}</Size>", p.size));
        xml.push_str("</Part>");
    }
    xml.push_str("</ListPartsResult>");
    xml
}

pub fn render_copy_object_result(meta: &ObjectMeta) -> String {
    let mut xml = String::from(XML_HEADER);
    xml.push_str(&format!("<CopyObjectResult xmlns=\"{S3_NS}\">"));
    xml.push_str(&format!(
        "<LastModified>{}</LastModified>",
        format_s3_timestamp(&meta.updated_at)
    ));
    xml.push_str(&format!("<ETag>{}</ETag>", ensure_quoted_etag(&meta.etag)));
    xml.push_str("</CopyObjectResult>");
    xml
}

pub fn render_location_constraint(region: &str) -> String {
    let mut xml = String::from(XML_HEADER);
    if region.is_empty() || region == "us-east-1" {
        xml.push_str(&format!("<LocationConstraint xmlns=\"{S3_NS}\"/>"));
    } else {
        xml.push_str(&format!(
            "<LocationConstraint xmlns=\"{S3_NS}\">{}</LocationConstraint>",
            escape_xml(region)
        ));
    }
    xml
}

fn local_tag_name(raw: &[u8]) -> &[u8] {
    match raw.iter().rposition(|&b| b == b':') {
        Some(idx) => &raw[idx + 1..],
        None => raw,
    }
}

/// Parses `<CompleteMultipartUpload>` XML body into a list of `CompletedPart`.
pub fn parse_complete_multipart_upload(xml_bytes: &[u8]) -> Result<Vec<CompletedPart>, S3Error> {
    let mut reader = Reader::from_reader(xml_bytes);
    reader.config_mut().trim_text(true);

    let mut buf = Vec::new();
    let mut parts = Vec::new();
    let mut in_root = false;
    let mut in_part = false;
    let mut current_tag: Option<String> = None;
    let mut current_part_number: Option<u32> = None;
    let mut current_etag: Option<String> = None;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let qname = e.name();
                let name = local_tag_name(qname.as_ref());
                match name {
                    b"CompleteMultipartUpload" | b"CompleteMultipartUploadRequest" => {
                        in_root = true;
                    }
                    b"Part" if in_root => {
                        in_part = true;
                        current_part_number = None;
                        current_etag = None;
                    }
                    b"PartNumber" if in_part => {
                        current_tag = Some("PartNumber".to_string());
                    }
                    b"ETag" if in_part => {
                        current_tag = Some("ETag".to_string());
                    }
                    _ => {
                        current_tag = None;
                    }
                }
            }
            Ok(Event::Text(e)) => {
                if let Some(ref tag) = current_tag {
                    let text = e
                        .unescape()
                        .map_err(|_| S3Error::malformed_xml("Invalid XML text escaping"))?;
                    match tag.as_str() {
                        "PartNumber" => {
                            let num = text.trim().parse::<u32>().map_err(|_| {
                                S3Error::malformed_xml(
                                    "Invalid PartNumber in CompleteMultipartUpload",
                                )
                            })?;
                            current_part_number = Some(num);
                        }
                        "ETag" => {
                            current_etag = Some(text.trim().trim_matches('"').to_string());
                        }
                        _ => {}
                    }
                }
            }
            Ok(Event::End(e)) => {
                let qname = e.name();
                let name = local_tag_name(qname.as_ref());
                match name {
                    b"Part" if in_part => {
                        let part_number = current_part_number.take().ok_or_else(|| {
                            S3Error::malformed_xml("Missing PartNumber in CompleteMultipartUpload")
                        })?;
                        let etag = current_etag.take().ok_or_else(|| {
                            S3Error::malformed_xml("Missing ETag in CompleteMultipartUpload")
                        })?;
                        parts.push(CompletedPart { part_number, etag });
                        in_part = false;
                        current_tag = None;
                    }
                    b"PartNumber" | b"ETag" => {
                        current_tag = None;
                    }
                    b"CompleteMultipartUpload" | b"CompleteMultipartUploadRequest" => {
                        in_root = false;
                    }
                    _ => {}
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => {
                return Err(S3Error::malformed_xml(
                    "The XML you provided was not well-formed or did not validate against our published schema.",
                ));
            }
            _ => {}
        }
        buf.clear();
    }

    if parts.is_empty() {
        return Err(S3Error::malformed_xml(
            "CompleteMultipartUpload must contain at least one Part",
        ));
    }

    Ok(parts)
}

/// Parses `<Delete>` multi-object delete XML request into `(keys, quiet)`.
pub fn parse_delete_objects(xml_bytes: &[u8]) -> Result<(Vec<String>, bool), S3Error> {
    let mut reader = Reader::from_reader(xml_bytes);
    reader.config_mut().trim_text(false);

    let mut buf = Vec::new();
    let mut keys = Vec::new();
    let mut quiet = false;
    let mut in_delete = false;
    let mut in_object = false;
    let mut current_tag: Option<String> = None;
    let mut current_key: Option<String> = None;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let qname = e.name();
                let name = local_tag_name(qname.as_ref());
                match name {
                    b"Delete" => in_delete = true,
                    b"Object" if in_delete => {
                        in_object = true;
                        current_key = None;
                    }
                    b"Key" if in_object => {
                        current_tag = Some("Key".to_string());
                        current_key = Some(String::new());
                    }
                    b"Quiet" if in_delete && !in_object => {
                        current_tag = Some("Quiet".to_string());
                    }
                    _ => {
                        current_tag = None;
                    }
                }
            }
            Ok(Event::Text(e)) => {
                if let Some(ref tag) = current_tag {
                    let text = e
                        .unescape()
                        .map_err(|_| S3Error::malformed_xml("Invalid XML text escaping"))?;
                    match tag.as_str() {
                        "Key" => {
                            if let Some(ref mut k) = current_key {
                                k.push_str(&text);
                            }
                        }
                        "Quiet" => {
                            quiet = text.trim().eq_ignore_ascii_case("true");
                        }
                        _ => {}
                    }
                }
            }
            Ok(Event::End(e)) => {
                let qname = e.name();
                let name = local_tag_name(qname.as_ref());
                match name {
                    b"Object" if in_object => {
                        let key = current_key.take().ok_or_else(|| {
                            S3Error::malformed_xml("Missing Key in Delete Object")
                        })?;
                        keys.push(key);
                        in_object = false;
                        current_tag = None;
                    }
                    b"Key" | b"Quiet" => {
                        current_tag = None;
                    }
                    b"Delete" => {
                        in_delete = false;
                    }
                    _ => {}
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => {
                return Err(S3Error::malformed_xml(
                    "The XML you provided was not well-formed or did not validate against our published schema.",
                ));
            }
            _ => {}
        }
        buf.clear();
    }

    if keys.is_empty() {
        return Err(S3Error::malformed_xml(
            "Delete request must specify at least one Object Key",
        ));
    }

    Ok((keys, quiet))
}

pub fn render_delete_objects_result(deleted_keys: &[String], quiet: bool) -> String {
    let mut xml = String::from(XML_HEADER);
    xml.push_str(&format!("<DeleteResult xmlns=\"{S3_NS}\">"));
    if !quiet {
        for key in deleted_keys {
            xml.push_str("<Deleted>");
            xml.push_str(&format!("<Key>{}</Key>", escape_xml(key)));
            xml.push_str("</Deleted>");
        }
    }
    xml.push_str("</DeleteResult>");
    xml
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use std::collections::BTreeMap;

    #[test]
    fn test_escape_xml_and_timestamp() {
        assert_eq!(
            escape_xml("a&b<c>d\"e'f"),
            "a&amp;b&lt;c&gt;d&quot;e&apos;f"
        );
        let dt = Utc.with_ymd_and_hms(2026, 11, 7, 1, 30, 0).unwrap();
        assert_eq!(format_s3_timestamp(&dt), "2026-11-07T01:30:00.000Z");
    }

    #[test]
    fn test_render_list_objects_v2() {
        let dt = Utc.with_ymd_and_hms(2026, 11, 7, 1, 30, 0).unwrap();
        let out = ListObjectsV2Output {
            name: "my-bucket".to_string(),
            prefix: "photos/".to_string(),
            delimiter: Some("/".to_string()),
            max_keys: 1000,
            is_truncated: false,
            contents: vec![ObjectMeta {
                bucket: "my-bucket".to_string(),
                key: "photos/a&b.jpg".to_string(),
                size: 42,
                etag: "1234567890abcdef".to_string(),
                content_type: "image/jpeg".to_string(),
                user_meta: BTreeMap::new(),
                updated_at: dt,
            }],
            common_prefixes: vec!["photos/2026/".to_string()],
            key_count: 2,
            continuation_token: None,
            next_continuation_token: None,
            start_after: None,
        };

        let xml = render_list_objects_v2(&out, false);
        assert!(xml.contains("<Name>my-bucket</Name>"));
        assert!(xml.contains("<Key>photos/a&amp;b.jpg</Key>"));
        assert!(xml.contains("<ETag>\"1234567890abcdef\"</ETag>"));
        assert!(xml.contains("<CommonPrefixes><Prefix>photos/2026/</Prefix></CommonPrefixes>"));

        let xml_url = render_list_objects_v2(&out, true);
        assert!(xml_url.contains("<EncodingType>url</EncodingType>"));
        assert!(xml_url.contains("<Key>photos/a%26b.jpg</Key>"));
    }

    #[test]
    fn test_parse_complete_multipart_upload() {
        let xml = br#"<?xml version="1.0" encoding="UTF-8"?>
        <s3:CompleteMultipartUpload xmlns:s3="http://s3.amazonaws.com/doc/2006-03-01/">
            <s3:Part>
                <s3:PartNumber>1</s3:PartNumber>
                <s3:ETag>"etag-part-1"</s3:ETag>
            </s3:Part>
            <s3:Part>
                <s3:PartNumber>2</s3:PartNumber>
                <s3:ETag>etag-part-2</s3:ETag>
            </s3:Part>
        </s3:CompleteMultipartUpload>"#;

        let parts = parse_complete_multipart_upload(xml).unwrap();
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0].part_number, 1);
        assert_eq!(parts[0].etag, "etag-part-1");
        assert_eq!(parts[1].part_number, 2);
        assert_eq!(parts[1].etag, "etag-part-2");

        let bad_xml = b"<CompleteMultipartUpload><Part><PartNumber>notanumber</PartNumber></Part></CompleteMultipartUpload>";
        let err = parse_complete_multipart_upload(bad_xml).unwrap_err();
        assert_eq!(err.code, "MalformedXML");
    }

    #[test]
    fn test_parse_and_render_delete_objects() {
        let xml = br#"<Delete>
            <Quiet>true</Quiet>
            <Object><Key>dir/file1 &amp; 2.txt</Key></Object>
            <Object><Key>dir/file3.txt</Key></Object>
        </Delete>"#;

        let (keys, quiet) = parse_delete_objects(xml).unwrap();
        assert!(quiet);
        assert_eq!(keys, vec!["dir/file1 & 2.txt", "dir/file3.txt"]);

        let rendered_quiet = render_delete_objects_result(&keys, true);
        assert!(!rendered_quiet.contains("<Deleted>"));

        let rendered_verbose = render_delete_objects_result(&keys, false);
        assert!(rendered_verbose.contains("<Deleted><Key>dir/file1 &amp; 2.txt</Key></Deleted>"));
    }

    #[test]
    fn test_render_other_xml_responses() {
        let dt = Utc.with_ymd_and_hms(2026, 11, 7, 1, 30, 0).unwrap();
        let buckets = vec![BucketInfo {
            name: "alpha".to_string(),
            public_read: false,
            created_at: dt,
            object_count: 0,
            total_bytes: 0,
        }];
        let buckets_xml = render_list_buckets(&buckets);
        assert!(buckets_xml.contains("<Name>alpha</Name>"));
        assert!(buckets_xml.contains("<CreationDate>2026-11-07T01:30:00.000Z</CreationDate>"));

        let mp_info = MultipartUploadInfo {
            upload_id: "up-123".to_string(),
            bucket: "alpha".to_string(),
            key: "large.bin".to_string(),
            content_type: "application/octet-stream".to_string(),
            user_meta: BTreeMap::new(),
            created_at: dt,
        };
        let init_xml = render_initiate_multipart_upload(&mp_info);
        assert!(init_xml.contains("<UploadId>up-123</UploadId>"));

        let parts = vec![PartInfo {
            part_number: 1,
            size: 5242880,
            etag: "part1etag".to_string(),
            updated_at: dt,
        }];
        let parts_xml = render_list_parts(&mp_info, &parts);
        assert!(parts_xml.contains("<PartNumber>1</PartNumber>"));
        assert!(parts_xml.contains("<ETag>\"part1etag\"</ETag>"));

        let meta = ObjectMeta {
            bucket: "alpha".to_string(),
            key: "large.bin".to_string(),
            size: 5242880,
            etag: "final-etag-1".to_string(),
            content_type: "application/octet-stream".to_string(),
            user_meta: BTreeMap::new(),
            updated_at: dt,
        };
        let comp_xml = render_complete_multipart_upload("/alpha/large.bin", &meta);
        assert!(comp_xml.contains("<Location>/alpha/large.bin</Location>"));
        assert!(comp_xml.contains("<ETag>\"final-etag-1\"</ETag>"));

        let copy_xml = render_copy_object_result(&meta);
        assert!(copy_xml.contains("<CopyObjectResult"));
        assert!(copy_xml.contains("<ETag>\"final-etag-1\"</ETag>"));

        let loc_default = render_location_constraint("us-east-1");
        assert!(
            loc_default.contains(
                "<LocationConstraint xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"/>"
            )
        );
        let loc_custom = render_location_constraint("eu-west-1");
        assert!(loc_custom.contains(">eu-west-1</LocationConstraint>"));
    }
}
