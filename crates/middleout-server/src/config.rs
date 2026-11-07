use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct AppConfig {
    pub host: String,
    pub port: u16,
    pub data_dir: PathBuf,
    pub access_key_id: String,
    pub secret_access_key: String,
    pub admin_user: String,
    pub admin_password: String,
    pub region: String,
    pub max_object_bytes: usize,
}

impl AppConfig {
    pub fn from_env() -> Self {
        Self::from_lookup(|key| std::env::var(key).ok())
    }

    pub fn from_lookup<F>(lookup: F) -> Self
    where
        F: Fn(&str) -> Option<String>,
    {
        let get_non_empty = |key: &str| -> Option<String> {
            lookup(key)
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
        };

        let host = get_non_empty("HOST")
            .or_else(|| get_non_empty("BIND_ADDRESS"))
            .unwrap_or_else(|| "0.0.0.0".to_string());

        let port = get_non_empty("PORT")
            .and_then(|v| v.parse::<u16>().ok())
            .unwrap_or(8080);

        let data_dir = get_non_empty("DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("./data"));

        let access_key_id = get_non_empty("MIDDLEOUT_ACCESS_KEY_ID")
            .or_else(|| get_non_empty("AWS_ACCESS_KEY_ID"))
            .unwrap_or_else(|| "middleout".to_string());

        let secret_access_key = get_non_empty("MIDDLEOUT_SECRET_ACCESS_KEY")
            .or_else(|| get_non_empty("AWS_SECRET_ACCESS_KEY"))
            .unwrap_or_else(|| "middleout-secret-key".to_string());

        let admin_user = get_non_empty("MIDDLEOUT_ADMIN_USER")
            .unwrap_or_else(|| access_key_id.clone());

        let admin_password = get_non_empty("MIDDLEOUT_ADMIN_PASSWORD")
            .unwrap_or_else(|| secret_access_key.clone());

        let region = get_non_empty("MIDDLEOUT_REGION")
            .or_else(|| get_non_empty("AWS_DEFAULT_REGION"))
            .unwrap_or_else(|| "us-east-1".to_string());

        let max_object_bytes = get_non_empty("MAX_OBJECT_BYTES")
            .and_then(|v| v.parse::<usize>().ok())
            .unwrap_or(1_073_741_824); // 1 GiB

        Self {
            host,
            port,
            data_dir,
            access_key_id,
            secret_access_key,
            admin_user,
            admin_password,
            region,
            max_object_bytes,
        }
    }

    pub fn bind_addr(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn test_default_config() {
        let map: HashMap<String, String> = HashMap::new();
        let cfg = AppConfig::from_lookup(|k| map.get(k).cloned());
        assert_eq!(cfg.host, "0.0.0.0");
        assert_eq!(cfg.port, 8080);
        assert_eq!(cfg.data_dir, PathBuf::from("./data"));
        assert_eq!(cfg.access_key_id, "middleout");
        assert_eq!(cfg.secret_access_key, "middleout-secret-key");
        assert_eq!(cfg.admin_user, "middleout");
        assert_eq!(cfg.admin_password, "middleout-secret-key");
        assert_eq!(cfg.region, "us-east-1");
        assert_eq!(cfg.max_object_bytes, 1_073_741_824);
    }

    #[test]
    fn test_aws_env_fallbacks() {
        let mut map = HashMap::new();
        map.insert("BIND_ADDRESS".to_string(), "127.0.0.1".to_string());
        map.insert("PORT".to_string(), "9000".to_string());
        map.insert("AWS_ACCESS_KEY_ID".to_string(), "aws-key".to_string());
        map.insert("AWS_SECRET_ACCESS_KEY".to_string(), "aws-secret".to_string());
        map.insert("AWS_DEFAULT_REGION".to_string(), "eu-west-1".to_string());

        let cfg = AppConfig::from_lookup(|k| map.get(k).cloned());
        assert_eq!(cfg.host, "127.0.0.1");
        assert_eq!(cfg.port, 9000);
        assert_eq!(cfg.access_key_id, "aws-key");
        assert_eq!(cfg.secret_access_key, "aws-secret");
        assert_eq!(cfg.admin_user, "aws-key");
        assert_eq!(cfg.admin_password, "aws-secret");
        assert_eq!(cfg.region, "eu-west-1");
    }

    #[test]
    fn test_middleout_overrides_aws_and_admin_overrides() {
        let mut map = HashMap::new();
        map.insert("AWS_ACCESS_KEY_ID".to_string(), "aws-key".to_string());
        map.insert("MIDDLEOUT_ACCESS_KEY_ID".to_string(), "mo-key".to_string());
        map.insert("MIDDLEOUT_ADMIN_USER".to_string(), "custom-admin".to_string());
        map.insert("MIDDLEOUT_ADMIN_PASSWORD".to_string(), "custom-pass".to_string());

        let cfg = AppConfig::from_lookup(|k| map.get(k).cloned());
        assert_eq!(cfg.access_key_id, "mo-key");
        assert_eq!(cfg.admin_user, "custom-admin");
        assert_eq!(cfg.admin_password, "custom-pass");
    }
}
