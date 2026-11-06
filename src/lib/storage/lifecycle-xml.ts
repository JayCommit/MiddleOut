import { XMLParser, XMLValidator } from "fast-xml-parser";
import { xmlEscape } from "../s3/xml.ts";
import { LifecycleError, validateLifecycleRules, type LifecycleRule } from "./lifecycle.ts";

type Node = Record<string, unknown>;
function node(value: unknown): Node {
  if (value === "") return {};
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new LifecycleError("Malformed lifecycle XML.", "MalformedXML");
  return value as Node;
}
function only(value: Node, allowed: string[]) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      const unsupported = [
        "Transition",
        "NoncurrentVersionTransition",
        "NoncurrentVersionExpiration",
        "ExpiredObjectDeleteMarker",
      ].includes(key);
      throw new LifecycleError(
        unsupported
          ? "Versioning and storage-class lifecycle actions are not supported."
          : `Unexpected lifecycle element: ${key}.`,
        unsupported ? "NotImplemented" : "MalformedXML",
        unsupported ? 501 : 400,
      );
    }
  }
}
function string(value: unknown): string {
  if (typeof value !== "string")
    throw new LifecycleError("Malformed lifecycle XML value.", "MalformedXML");
  return value;
}
function number(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const raw = string(value).trim();
  if (!/^\d+$/.test(raw))
    throw new LifecycleError("Lifecycle numeric values must be whole numbers.");
  return Number(raw);
}

export function parseLifecycleXml(xml: string): LifecycleRule[] {
  if (new TextEncoder().encode(xml).length > 512 * 1024)
    throw new LifecycleError("Lifecycle configuration exceeds 512 KiB.", "EntityTooLarge", 413);
  // Ignore literal text/comments when checking declarations, then reject DTDs before parsing.
  const entityText = xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->/g, "");
  if (/<!DOCTYPE|<!ENTITY/i.test(entityText) || XMLValidator.validate(xml) !== true)
    throw new LifecycleError(
      "Malformed lifecycle XML. DTDs and entities are not supported.",
      "MalformedXML",
    );
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);)/.test(entityText))
    throw new LifecycleError("Unknown XML entity.", "MalformedXML");
  let parsed: Node;
  try {
    parsed = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@",
      removeNSPrefix: true,
      ignoreDeclaration: true,
      ignorePiTags: true,
      parseTagValue: false,
      htmlEntities: true,
      trimValues: false,
      isArray: (name) => name === "Rule" || name === "Tag",
    }).parse(xml) as Node;
  } catch {
    throw new LifecycleError("Malformed lifecycle XML.", "MalformedXML");
  }
  only(parsed, ["LifecycleConfiguration"]);
  const root = node(parsed.LifecycleConfiguration);
  only(root, ["Rule"]);
  if (!Array.isArray(root.Rule))
    throw new LifecycleError("Lifecycle configuration requires rules.", "MalformedXML");
  const rules = root.Rule.map((raw, index) => {
    const r = node(raw);
    only(r, [
      "ID",
      "Filter",
      "Prefix",
      "Status",
      "Expiration",
      "AbortIncompleteMultipartUpload",
      "Transition",
      "NoncurrentVersionTransition",
      "NoncurrentVersionExpiration",
    ]);
    for (const unsupported of [
      "Transition",
      "NoncurrentVersionTransition",
      "NoncurrentVersionExpiration",
    ])
      if (r[unsupported] !== undefined)
        throw new LifecycleError(
          "Versioning and storage-class lifecycle actions are not supported.",
          "NotImplemented",
          501,
        );
    if ((r.Filter === undefined) === (r.Prefix === undefined))
      throw new LifecycleError("Use exactly one Filter or legacy Prefix element.", "MalformedXML");
    let filter: Node;
    if (r.Prefix !== undefined) filter = { Prefix: r.Prefix };
    else {
      filter = node(r.Filter);
      only(filter, ["Prefix", "Tag", "ObjectSizeGreaterThan", "ObjectSizeLessThan", "And"]);
      if (filter.And !== undefined) {
        if (Object.keys(filter).length !== 1)
          throw new LifecycleError("And cannot be combined with sibling filters.", "MalformedXML");
        filter = node(filter.And);
        only(filter, ["Prefix", "Tag", "ObjectSizeGreaterThan", "ObjectSizeLessThan"]);
        const count =
          Object.keys(filter).filter((key) => key !== "Tag").length +
          (Array.isArray(filter.Tag) ? filter.Tag.length : 0);
        if (count < 2)
          throw new LifecycleError("And requires at least two filter conditions.", "MalformedXML");
      } else if (
        Object.keys(filter).length > 1 ||
        (Array.isArray(filter.Tag) && filter.Tag.length > 1)
      )
        throw new LifecycleError(
          "Multiple filter conditions must be wrapped in And.",
          "MalformedXML",
        );
    }
    const tags =
      filter.Tag === undefined
        ? []
        : (filter.Tag as unknown[]).map((rawTag) => {
            const tag = node(rawTag);
            only(tag, ["Key", "Value"]);
            return { key: string(tag.Key), value: string(tag.Value) };
          });
    const expiration = r.Expiration === undefined ? {} : node(r.Expiration);
    only(expiration, ["Days", "Date"]);
    if (r.Expiration !== undefined && Object.keys(expiration).length !== 1)
      throw new LifecycleError("Expiration requires exactly one Days or Date.", "MalformedXML");
    const abort =
      r.AbortIncompleteMultipartUpload === undefined ? {} : node(r.AbortIncompleteMultipartUpload);
    only(abort, ["DaysAfterInitiation"]);
    if (r.AbortIncompleteMultipartUpload !== undefined && abort.DaysAfterInitiation === undefined)
      throw new LifecycleError("Abort action requires DaysAfterInitiation.", "MalformedXML");
    return {
      id: r.ID === undefined ? `rule-${index + 1}` : string(r.ID),
      status: string(r.Status).trim(),
      prefix: filter.Prefix === undefined ? "" : string(filter.Prefix),
      tags,
      ...(filter.ObjectSizeGreaterThan !== undefined && {
        sizeGreaterThan: number(filter.ObjectSizeGreaterThan),
      }),
      ...(filter.ObjectSizeLessThan !== undefined && {
        sizeLessThan: number(filter.ObjectSizeLessThan),
      }),
      ...(expiration.Days !== undefined && { expirationDays: number(expiration.Days) }),
      ...(expiration.Date !== undefined && { expirationDate: string(expiration.Date).trim() }),
      ...(abort.DaysAfterInitiation !== undefined && {
        abortDays: number(abort.DaysAfterInitiation),
      }),
    };
  });
  return validateLifecycleRules(rules);
}

const escape = (value: string) => xmlEscape(value).replace(/\r/g, "&#13;");
export function lifecycleXml(rules: LifecycleRule[]): string {
  const body = rules
    .map((r) => {
      const filters = [
        r.prefix ? `<Prefix>${escape(r.prefix)}</Prefix>` : "",
        ...r.tags.map(
          (tag) => `<Tag><Key>${escape(tag.key)}</Key><Value>${escape(tag.value)}</Value></Tag>`,
        ),
        r.sizeGreaterThan !== undefined
          ? `<ObjectSizeGreaterThan>${r.sizeGreaterThan}</ObjectSizeGreaterThan>`
          : "",
        r.sizeLessThan !== undefined
          ? `<ObjectSizeLessThan>${r.sizeLessThan}</ObjectSizeLessThan>`
          : "",
      ].filter(Boolean);
      const filter = filters.length > 1 ? `<And>${filters.join("")}</And>` : filters.join("");
      const expiration =
        r.expirationDays !== undefined
          ? `<Expiration><Days>${r.expirationDays}</Days></Expiration>`
          : r.expirationDate
            ? `<Expiration><Date>${r.expirationDate}</Date></Expiration>`
            : "";
      const abort =
        r.abortDays !== undefined
          ? `<AbortIncompleteMultipartUpload><DaysAfterInitiation>${r.abortDays}</DaysAfterInitiation></AbortIncompleteMultipartUpload>`
          : "";
      return `<Rule><ID>${escape(r.id)}</ID><Filter>${filter}</Filter><Status>${r.status}</Status>${expiration}${abort}</Rule>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><LifecycleConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${body}</LifecycleConfiguration>`;
}
