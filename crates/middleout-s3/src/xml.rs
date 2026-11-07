use crate::error::S3Error;

pub fn render_error(err: &S3Error) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<Error><Code>{}</Code><Message>{}</Message><RequestId>{}</RequestId></Error>",
        err.code, err.message, err.request_id
    )
}
