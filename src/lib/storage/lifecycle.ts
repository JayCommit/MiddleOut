export interface LifecycleRule {
  id: string;
  status: "Enabled" | "Disabled";
  prefix: string;
  tags: { key: string; value: string }[];
  sizeGreaterThan?: number;
  sizeLessThan?: number;
  expirationDays?: number;
  expirationDate?: string;
  abortDays?: number;
}

export class LifecycleError extends Error {
  code: string;
  status: number;
  constructor(message: string, code = "InvalidArgument", status = 400) {
    super(message);
    this.name = "LifecycleError";
    this.code = code;
    this.status = status;
  }
}

const fields = new Set([
  "id",
  "status",
  "prefix",
  "tags",
  "sizeGreaterThan",
  "sizeLessThan",
  "expirationDays",
  "expirationDate",
  "abortDays",
]);
function integer(value: unknown, name: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new LifecycleError(`${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}
function hasXmlControls(value: string): boolean {
  for (const character of value) {
    const point = character.codePointAt(0)!;
    if (
      (point < 32 && point !== 9 && point !== 10 && point !== 13) ||
      (point >= 0xd800 && point <= 0xdfff) ||
      point === 0xfffe ||
      point === 0xffff
    )
      return true;
  }
  return false;
}
function text(value: unknown, name: string, max: number, empty = true): string {
  if (
    typeof value !== "string" ||
    (!empty && !value.length) ||
    value.length > max ||
    hasXmlControls(value)
  ) {
    throw new LifecycleError(
      `${name} must be ${empty ? "at most" : "1–"}${max} characters without XML control characters.`,
    );
  }
  return value;
}

/** Strict validation is shared by console and S3: invalid filters never broaden a rule. */
export function validateLifecycleRules(input: unknown): LifecycleRule[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 1000)
    throw new LifecycleError("Provide between 1 and 1,000 lifecycle rules.");
  const ids = new Set<string>();
  return input.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new LifecycleError("Invalid lifecycle rule.");
    const r = item as Record<string, unknown>;
    if (Object.keys(r).some((key) => !fields.has(key)))
      throw new LifecycleError("Unknown lifecycle rule field.");
    const id = text(r.id ?? `rule-${index + 1}`, "Rule ID", 255, false);
    if (ids.has(id)) throw new LifecycleError("Rule IDs must be unique.");
    ids.add(id);
    if (r.status !== "Enabled" && r.status !== "Disabled")
      throw new LifecycleError("Rule status must be Enabled or Disabled.");
    const prefix = text(r.prefix ?? "", "Prefix", 1024);
    if (new TextEncoder().encode(prefix).length > 1024)
      throw new LifecycleError("Prefix must not exceed 1,024 UTF-8 bytes.");
    const tags = r.tags ?? [];
    if (!Array.isArray(tags) || tags.length > 10)
      throw new LifecycleError("At most 10 tag filters are supported.");
    const tagKeys = new Set<string>();
    const validTags = tags.map((tag) => {
      if (
        !tag ||
        typeof tag !== "object" ||
        Object.keys(tag).some((key) => key !== "key" && key !== "value")
      )
        throw new LifecycleError("Invalid tag filter.");
      const key = text(tag.key, "Tag key", 128, false);
      const value = text(tag.value, "Tag value", 256);
      if (tagKeys.has(key)) throw new LifecycleError("Tag filter keys must be unique.");
      tagKeys.add(key);
      return { key, value };
    });
    const sizeGreaterThan = integer(r.sizeGreaterThan, "Minimum size", 0, Number.MAX_SAFE_INTEGER);
    const sizeLessThan = integer(r.sizeLessThan, "Maximum size", 1, Number.MAX_SAFE_INTEGER);
    if (
      sizeGreaterThan !== undefined &&
      sizeLessThan !== undefined &&
      sizeGreaterThan >= sizeLessThan
    )
      throw new LifecycleError("Minimum size must be less than maximum size.");
    const expirationDays = integer(r.expirationDays, "Expiration days", 1, 365000);
    const abortDays = integer(r.abortDays, "Abort days", 1, 365000);
    let expirationDate: string | undefined;
    if (r.expirationDate !== undefined) {
      const date = text(r.expirationDate, "Expiration date", 32, false);
      const time = Date.parse(date);
      if (
        !/^\d{4}-\d{2}-\d{2}T00:00:00(?:\.0{1,3})?Z$/.test(date) ||
        !Number.isFinite(time) ||
        new Date(time).toISOString().slice(0, 10) !== date.slice(0, 10)
      )
        throw new LifecycleError("Expiration date must be a valid date at midnight UTC.");
      expirationDate = new Date(time).toISOString();
    }
    if (expirationDays !== undefined && expirationDate !== undefined)
      throw new LifecycleError("Use an expiration age or date, not both.");
    if (expirationDays === undefined && expirationDate === undefined && abortDays === undefined)
      throw new LifecycleError("Each rule needs an expiration or abort action.");
    if (
      abortDays !== undefined &&
      (validTags.length || sizeGreaterThan !== undefined || sizeLessThan !== undefined)
    )
      throw new LifecycleError(
        "Incomplete upload rules support prefix filters only; use a separate rule for tagged or size-filtered objects.",
      );
    return {
      id,
      status: r.status,
      prefix,
      tags: validTags,
      ...(sizeGreaterThan !== undefined && { sizeGreaterThan }),
      ...(sizeLessThan !== undefined && { sizeLessThan }),
      ...(expirationDays !== undefined && { expirationDays }),
      ...(expirationDate !== undefined && { expirationDate }),
      ...(abortDays !== undefined && { abortDays }),
    };
  });
}

export function lifecycleMatches(
  rule: LifecycleRule,
  object: { key: string; size: number; tags: { key: string; value: string }[] },
): boolean {
  return (
    rule.status === "Enabled" &&
    object.key.startsWith(rule.prefix) &&
    (rule.sizeGreaterThan === undefined || object.size > rule.sizeGreaterThan) &&
    (rule.sizeLessThan === undefined || object.size < rule.sizeLessThan) &&
    rule.tags.every((tag) =>
      object.tags.some((value) => value.key === tag.key && value.value === tag.value),
    )
  );
}

export function lifecycleExpiry(rule: LifecycleRule, writtenAt: string): number | null {
  if (rule.expirationDate) return Date.parse(rule.expirationDate);
  if (rule.expirationDays === undefined) return null;
  const day = 86400000;
  return Math.ceil((Date.parse(writtenAt) + rule.expirationDays * day) / day) * day;
}
