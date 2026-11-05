/** @param {string} name @param {number} fallback @param {number} min @param {number} max */
export function integerSetting(name, fallback, min, max) {
  const raw = process.env[name] || String(fallback);
  if (
    !/^\d+$/.test(raw) ||
    !Number.isSafeInteger(Number(raw)) ||
    Number(raw) < min ||
    Number(raw) > max
  )
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  return Number(raw);
}
export const maxObjectBytes = integerSetting(
  "MAX_OBJECT_BYTES",
  1024 * 1024 * 1024, // 1 GB default (configurable higher or lower)
  1,
  5 * 1024 ** 4, // 5 TB ceiling (AWS S3 max object size)
);
export const accountQuotaBytes = integerSetting(
  "ACCOUNT_QUOTA_BYTES",
  10 * 1024 * 1024 * 1024, // 10 GB default
  maxObjectBytes,
  1024 ** 5,
);
export const maxRequestBytes = Math.max(
  12 * 1024 * 1024,
  Math.ceil((maxObjectBytes * 4) / 3) + 1024 * 1024,
);
export const maintenanceSeconds = integerSetting("MAINTENANCE_INTERVAL_SECONDS", 3600, 60, 86400);
export const auditRetentionDays = integerSetting("AUDIT_RETENTION_DAYS", 90, 1, 3650);
