// Expand JSON Schema constructs that agy's ACP -> CloudCode Schema translator
// either ignores or drops (`$ref` into `$defs`/`definitions`, `allOf`, `oneOf`,
// object/primitive `anyOf` unions, `const` discriminators, `additionalProperties`
// dictionaries, and boolean schemas), before `sanitizeInputSchema` and
// `ensureGeminiArrayItems` normalize types, RE2 patterns, and untyped arrays.
//
// Nullable unions lower to `type: [X, "null"]` (matching `sanitizeInputSchema`),
// which both agy's local JSON Schema validator and its CloudCode schema
// translator accept for null and non-null values alike.
//
// Ported from the MIT-licensed agy-cli bridge (see LICENSE). Local
// $ref/allOf/const expansion inspired by DylanLIiii/opencode-antigravity-bridge
// (MIT).

import { createHash } from "node:crypto"

import type { NormalizedAnthropicRequest, NormalizedToolDef } from "../../types"
import { ensureGeminiArrayItems } from "./array-items"
import { appendHint, sanitizePatternFields } from "./re2-pattern"

export type JsonSchema = Record<string, unknown>

function isObject(value: unknown): value is JsonSchema {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function propAt(schema: JsonSchema, key: string): unknown[] {
  const properties = schema.properties
  return isObject(properties) && Object.hasOwn(properties, key) ? [properties[key]] : []
}

const NUMBER_BOUNDS = [
  "minimum", "maximum", "minLength", "maxLength",
  "minItems", "maxItems", "minProperties", "maxProperties",
]
const CONTAINER_MAPS = ["properties", "patternProperties", "dependentSchemas"] as const
const BOOLEAN_OR_SCHEMA_CHILDREN = ["additionalProperties", "unevaluatedProperties", "unevaluatedItems"] as const
const SCHEMA_ONLY_CHILDREN = ["propertyNames", "contains", "if", "then", "else", "not"] as const
const VISITED_OBJECT_KEYS = new Set<string>([
  ...CONTAINER_MAPS,
  ...BOOLEAN_OR_SCHEMA_CHILDREN,
  ...SCHEMA_ONLY_CHILDREN,
  "prefixItems", "items", "anyOf", "oneOf",
])
// Keywords whose value is a name -> schema map: a pointer may pass through
// them but must not stop on them.
const POINTER_MAP_KEYWORDS = new Set<string>(["properties", "patternProperties", "dependentSchemas", "$defs", "definitions"])

// Only `$ref` and `allOf` inlining is charged; ordinary traversal is free.
const MAX_INLINED_NODES = 8192
const MAX_INLINED_BYTES = 256 * 1024
const MAX_DEPTH = 64
const MAX_VARIANT_HINT_CHARS = 1600
const MAX_VARIANT_SUMMARY_CHARS = 240
const MAX_VARIANT_DESCRIPTION_CHARS = 80

const ANY_VALUE_HINT = "Accepts any JSON value."
const NO_VALUE_HINT = "No value is allowed by the original schema."
const NULL_HINT = "Must be null."
const RECURSIVE_HINT = "Recursive schema; follow the tool's original argument contract."
const LIMIT_HINT = "Schema expansion limit reached; follow the tool's original argument contract."

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 3).trimEnd()}...` : flat
}

function scalarBytes(value: unknown): number {
  if (typeof value === "string") return Buffer.byteLength(value) + 2
  if (typeof value === "number" || typeof value === "boolean") return String(value).length
  return 4
}

function ownBytes(out: JsonSchema): number {
  let bytes = 2
  for (const [key, value] of Object.entries(out)) {
    if (value === undefined) continue
    bytes += Buffer.byteLength(key) + 4
    if (value === null || typeof value !== "object") {
      bytes += scalarBytes(value)
    } else if (key === "properties" || key === "patternProperties" || key === "dependentSchemas") {
      bytes += 2
      if (isObject(value)) for (const mapKey of Object.keys(value)) bytes += Buffer.byteLength(mapKey) + 4
    } else if (VISITED_OBJECT_KEYS.has(key)) {
      bytes += 2
    } else if (Array.isArray(value) && value.every((item) => item === null || typeof item !== "object")) {
      bytes += 2
      for (const item of value) bytes += scalarBytes(item) + 1
    } else {
      bytes += Buffer.byteLength(JSON.stringify(value) ?? "")
    }
  }
  return bytes
}

function resolvePointer(root: JsonSchema, ref: unknown): unknown {
  if (typeof ref !== "string") return undefined
  if (ref === "#") return root
  if (!ref.startsWith("#/")) return undefined
  let parts: string[]
  try {
    parts = decodeURIComponent(ref.slice(2)).split("/")
  } catch {
    return undefined
  }
  let target: unknown = root
  let inMap = false
  for (const part of parts) {
    const key = part.replace(/~1/g, "/").replace(/~0/g, "~")
    if ((!isObject(target) && !Array.isArray(target)) || !Object.hasOwn(target, key)) return undefined
    // Inside a map the key is a name (`#/properties/properties` is a schema);
    // at a schema node it is a keyword.
    const entersMap: boolean = !inMap && isObject(target) && POINTER_MAP_KEYWORDS.has(key)
    const container: Record<string, unknown> = target as Record<string, unknown>
    target = container[key]
    inMap = entersMap
  }
  if (inMap) return undefined
  return isObject(target) || typeof target === "boolean" ? target : undefined
}

function isNullType(type: unknown): boolean {
  return type === "null" || (Array.isArray(type) && type.length === 1 && type[0] === "null")
}

function isNullSchema(schema: unknown): boolean {
  if (!isObject(schema)) return false
  if (isNullType(schema.type)) return true
  // A lowered `const: null` leaf (no type, only the null hint).
  return schema.type === undefined && typeof schema.description === "string" &&
    schema.description.includes(NULL_HINT) && schema.properties === undefined &&
    schema.items === undefined && schema.enum === undefined && schema.const === undefined &&
    schema.anyOf === undefined && schema.oneOf === undefined
}

function declaresArray(schema: unknown): boolean {
  if (!isObject(schema)) return false
  return schema.type === "array" || (Array.isArray(schema.type) && schema.type.includes("array"))
}

function isObjectBranch(schema: unknown): boolean {
  if (!isObject(schema)) return false
  if (schema.type === "object") return true
  if (Array.isArray(schema.type) && schema.type.includes("object") &&
    schema.type.every((t) => t === "object" || t === "null")) {
    return true
  }
  if (schema.type !== undefined) return false
  return isObject(schema.properties) || Array.isArray(schema.required) ||
    schema.additionalProperties !== undefined || isObject(schema.patternProperties)
}

function primitiveTypeOf(schema: unknown): string | null {
  if (!isObject(schema)) return null
  const raw = typeof schema.type === "string"
    ? [schema.type]
    : Array.isArray(schema.type)
      ? schema.type.filter((t) => t !== "null")
      : []
  if (raw.length !== 1) return null
  const t = raw[0]
  return (t === "string" || t === "number" || t === "integer" || t === "boolean") ? t : null
}

// Stand-in for a subtree that is not expanded (recursion, depth or budget):
// keep what kind of value it is, never invent a type it did not declare.
function structuralFallback(schema: unknown, hint: string): JsonSchema {
  const nullable = isObject(schema) && Array.isArray(schema.type) && schema.type.includes("null")
  const withNull = (t: string): string | string[] => (nullable ? [t, "null"] : t)
  if (isObjectBranch(schema)) return { type: withNull("object"), description: hint }
  if (declaresArray(schema)) return { type: withNull("array"), description: hint }
  const prim = primitiveTypeOf(schema)
  if (prim) return { type: withNull(prim), description: hint }
  return { description: hint }
}

function summarizeSchema(schema: unknown, depth = 0): string {
  if (!isObject(schema)) return schema === false ? "never" : "any"
  if (Array.isArray(schema.enum) && schema.enum.length) {
    const shown = schema.enum.slice(0, 12).map((v) => JSON.stringify(v)).join(" | ")
    return schema.enum.length > 12 ? `${shown} | ...` : shown
  }
  if (schema.const !== undefined) return JSON.stringify(schema.const)
  const types = Array.isArray(schema.type) ? schema.type : typeof schema.type === "string" ? [schema.type] : []
  const rawType = types.length ? types.join("|") : undefined
  const nullable = types.includes("null")
  const nonNullTypes = types.filter((t) => t !== "null")
  const properties = schema.properties
  if ((!rawType || (nonNullTypes.length === 1 && nonNullTypes[0] === "object")) && isObject(properties)) {
    if (depth >= 2) return rawType ?? "object"
    const req = new Set(Array.isArray(schema.required) ? schema.required : [])
    const entries = Object.entries(properties)
    const shown = entries.slice(0, 8).map(([k, v]) => `${k}${req.has(k) ? "" : "?"}: ${summarizeSchema(v, depth + 1)}`)
    if (entries.length > 8) shown.push("...")
    const body = `{ ${shown.join(", ")} }`
    return nullable ? `${body} | null` : body
  }
  if ((!rawType || rawType === "object") && Array.isArray(schema.required) && schema.required.length) {
    return `{ required: [${schema.required.join(", ")}] }`
  }
  const items = schema.items
  if ((nonNullTypes.length === 1 && nonNullTypes[0] === "array") || (!rawType && isObject(items))) {
    if (depth >= 2 || !isObject(items)) return rawType ?? "array"
    const body = `array<${summarizeSchema(items, depth + 1)}>`
    return nullable ? `${body} | null` : body
  }
  const combo = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : null
  if (combo && combo.length) {
    if (depth >= 2) return "union"
    const shown = combo.slice(0, 6).map((b) => summarizeSchema(b, depth + 1)).join(" | ")
    return combo.length > 6 ? `${shown} | ...` : shown
  }
  return rawType ?? "any"
}

function typeList(type: unknown): string[] | null {
  if (typeof type === "string") return [type]
  if (Array.isArray(type)) return type.filter((t): t is string => typeof t === "string")
  return null
}

interface TypeIntersection {
  type: unknown
  conflict?: boolean
}

function intersectTypes(a: unknown, b: unknown): TypeIntersection {
  const left = typeList(a)
  const right = typeList(b)
  if (!left || !left.length) return { type: b }
  if (!right || !right.length) return { type: a }
  const common = new Set<string>()
  for (const t of left) {
    if (right.includes(t)) common.add(t)
    else if ((t === "number" && right.includes("integer")) || (t === "integer" && right.includes("number"))) {
      common.add("integer")
    }
  }
  if (!common.size) return { type: a, conflict: true }
  const nonNull = [...common].filter((t) => t !== "null")
  const list = common.has("null") ? [...nonNull, "null"] : nonNull
  return { type: list.length === 1 ? list[0] : list }
}

function intersectSchemas(schemas: unknown[]): JsonSchema {
  const meaningful = schemas.filter((schema): schema is JsonSchema => isObject(schema) && Object.keys(schema).length > 0)
  if (!meaningful.length) return {}
  const first = meaningful[0]!
  if (meaningful.length === 1) return { ...first }
  const out: JsonSchema = { ...first }
  const conflicts: string[] = []
  for (const schema of meaningful.slice(1)) {
    if (typeof schema.description === "string") appendHint(out, schema.description)
    for (const [key, value] of Object.entries(schema)) {
      if (key === "description" || key === "properties" || key === "required" || key === "items" ||
          key === "enum" || key === "type" || NUMBER_BOUNDS.includes(key)) continue
      if (out[key] === undefined) out[key] = value
    }
    if (schema.type !== undefined) {
      const merged = intersectTypes(out.type, schema.type)
      if (merged.conflict) conflicts.push(`${(typeList(out.type) ?? []).join("|")} vs ${(typeList(schema.type) ?? []).join("|")}`)
      out.type = merged.type
    }
  }
  for (const conflict of conflicts) appendHint(out, `Conflicting type constraints in allOf: ${conflict}.`)
  const objects = meaningful.filter((schema) => isObject(schema.properties))
  if (objects.length) {
    const keys = [...new Set(objects.flatMap((schema) => isObject(schema.properties) ? Object.keys(schema.properties) : []))]
    out.properties = Object.fromEntries(keys.map((key) => [
      key,
      intersectSchemas(objects.flatMap((schema) => propAt(schema, key))),
    ]))
    out.type ??= "object"
  }
  const reqKeys = [...new Set(meaningful.flatMap((schema) => Array.isArray(schema.required) ? schema.required : []))]
  if (reqKeys.length) {
    out.required = reqKeys
    out.type ??= "object"
  }
  const arrays = meaningful.filter((schema) => isObject(schema.items))
  if (arrays.length) {
    out.items = intersectSchemas(arrays.map((schema) => schema.items))
    out.type ??= "array"
  }
  for (const key of NUMBER_BOUNDS) {
    const values = meaningful
      .map((schema) => schema[key])
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
    if (!values.length) continue
    const lower = key === "minimum" || key.startsWith("min")
    out[key] = (lower ? Math.max : Math.min)(...values)
  }
  const enums = meaningful.filter((schema) => Array.isArray(schema.enum))
  if (enums.length) {
    const firstEnum = enums[0]?.enum
    if (Array.isArray(firstEnum)) {
      const common = firstEnum.filter((value) =>
        enums.every((schema) => Array.isArray(schema.enum) && schema.enum.includes(value)))
      if (common.length) {
        out.enum = [...new Set(common)]
      } else {
        delete out.enum
        appendHint(out, "Conflicting enum constraints in allOf.")
      }
    }
  }
  return out
}

function primitiveFamily(nonNull: unknown[]): string | null {
  const types = new Set<string>()
  for (const branch of nonNull) {
    const t = primitiveTypeOf(branch)
    if (!t) return null
    types.add(t)
  }
  if (types.size === 1) return [...types][0] ?? null
  if (types.size === 2 && types.has("number") && types.has("integer")) return "number"
  return null
}

function branchLiterals(branch: JsonSchema): unknown[] | null {
  if (Array.isArray(branch.enum) && branch.enum.length > 0) return branch.enum
  if (branch.const !== undefined && branch.const !== null) return [branch.const]
  return null
}

function unionPrimitiveBranches(nonNull: JsonSchema[], family: string, hasNull: boolean): JsonSchema {
  const out: JsonSchema = { type: hasNull ? [family, "null"] : family }
  const descriptions = [...new Set(
    nonNull.map((b) => typeof b.description === "string" ? b.description.trim() : "").filter(Boolean),
  )]
  if (descriptions.length) out.description = descriptions.slice(0, 3).join("; ")

  // A `const` is a one-value enum. sanitizeInputSchema keeps non-empty string
  // enums and turns numeric, boolean, or null-bearing ones into an "Allowed values" hint.
  const literals = nonNull.map(branchLiterals)
  if (literals.every((literal): literal is unknown[] => literal !== null)) {
    const values = [...new Set(literals.flat().filter((v) => v !== null))]
    out.enum = hasNull ? [...values, null] : values
  } else if (literals.some((literal) => literal !== null)) {
    const known = [...new Set(literals.flatMap((literal) => literal ?? []))]
      .slice(0, 12)
      .map((v) => JSON.stringify(v))
      .join(", ")
    appendHint(out, `Known values include: ${known}`)
  }

  for (const key of NUMBER_BOUNDS) {
    if (!nonNull.every((b) => typeof b[key] === "number" && Number.isFinite(b[key]))) continue
    const values = nonNull.map((b) => b[key] as number)
    const lower = key === "minimum" || key.startsWith("min")
    out[key] = (lower ? Math.min : Math.max)(...values)
  }
  const formats = [...new Set(nonNull.map((b) => b.format).filter((f): f is string => typeof f === "string" && f.length > 0))]
  if (formats.length === 1 && nonNull.every((b) => b.format === formats[0])) out.format = formats[0]
  const patterns = [...new Set(nonNull.map((b) => b.pattern).filter((p): p is string => typeof p === "string" && p.length > 0))]
  if (patterns.length === 1 && nonNull.every((b) => b.pattern === patterns[0])) out.pattern = patterns[0]

  return out
}

function unionPropertySchemas(schemas: unknown[]): JsonSchema {
  const meaningful = schemas.filter((schema): schema is JsonSchema => isObject(schema))
  if (!meaningful.length) return {}
  const first = meaningful[0]!
  if (meaningful.length === 1) return { ...first }
  const nonNull = meaningful.filter((b) => !isNullSchema(b))
  const hasNull = nonNull.length < meaningful.length ||
    meaningful.some((b) => Array.isArray(b.type) && b.type.includes("null"))
  if (!nonNull.length) return { description: NULL_HINT }
  if (nonNull.every(isObjectBranch)) return unionObjectBranches(nonNull, hasNull)
  const family = primitiveFamily(nonNull)
  if (family) return unionPrimitiveBranches(nonNull, family, hasNull)
  return {
    anyOf: meaningful,
    description: `Accepts anyOf: ${meaningful.map((b) => summarizeSchema(b)).join(" | ")}`,
  }
}

function variantsHint(branches: JsonSchema[]): string {
  const parts: string[] = []
  let length = 0
  for (let i = 0; i < branches.length; i++) {
    const branch = branches[i]
    if (!branch) continue
    let part = clip(summarizeSchema(branch, 1), MAX_VARIANT_SUMMARY_CHARS)
    if (typeof branch.description === "string" && branch.description.trim()) {
      part += ` (${clip(branch.description, MAX_VARIANT_DESCRIPTION_CHARS)})`
    }
    if (parts.length && length + part.length + 3 > MAX_VARIANT_HINT_CHARS) {
      parts.push(`... (+${branches.length - i} more)`)
      break
    }
    parts.push(part)
    length += part.length + 3
  }
  return `Variants: ${parts.join(" | ")}`
}

function unionObjectBranches(nonNull: JsonSchema[], hasNull: boolean): JsonSchema {
  const out: JsonSchema = { type: hasNull ? ["object", "null"] : "object" }
  const only = nonNull[0]
  if (nonNull.length === 1 && only && typeof only.description === "string" && only.description.trim()) {
    out.description = only.description
  }
  const propKeys = [...new Set(nonNull.flatMap((b) => isObject(b.properties) ? Object.keys(b.properties) : []))]
  if (propKeys.length) {
    out.properties = Object.fromEntries(propKeys.map((key) => [
      key,
      unionPropertySchemas(nonNull.flatMap((b) => propAt(b, key))),
    ]))
  }
  const reqSets = nonNull.map((b) => new Set(
    Array.isArray(b.required) ? b.required.filter((key): key is string => typeof key === "string") : [],
  ))
  const firstSet = reqSets[0] ?? new Set<string>()
  const commonReq = [...firstSet].filter((key) => reqSets.every((set) => set.has(key)))
  if (commonReq.length) out.required = commonReq

  if (nonNull.some((b) => b.additionalProperties === true)) {
    out.additionalProperties = true
  } else if (nonNull.some((b) => isObject(b.additionalProperties))) {
    out.additionalProperties = unionPropertySchemas(nonNull.flatMap((b) => isObject(b.additionalProperties) ? [b.additionalProperties] : []))
  } else if (nonNull.every((b) => b.additionalProperties === false)) {
    out.additionalProperties = false
  }

  if (nonNull.length > 1) appendHint(out, variantsHint(nonNull))
  return out
}

function lowerUnionKey(out: JsonSchema, key: string): JsonSchema {
  const branches = out[key]
  if (!Array.isArray(branches)) return out
  if (!branches.length) {
    delete out[key]
    return out
  }
  const nonNull = branches.filter((b) => !isNullSchema(b))
  const hasNull = nonNull.length < branches.length ||
    branches.some((b) => isObject(b) && Array.isArray(b.type) && b.type.includes("null"))

  if (!nonNull.length) {
    delete out[key]
    if (isNullType(out.type)) delete out.type
    appendHint(out, NULL_HINT)
    return out
  }

  // Leave array-bearing combinators intact so `ensureGeminiArrayItems` can lift
  // item schemas without narrowing `string | string[]` or `array | null`.
  if (declaresArray(out) || nonNull.some((branch) => declaresArray(branch))) {
    if (key === "oneOf") {
      const current = out.anyOf
      out.anyOf = Array.isArray(current) ? [...current, ...branches] : branches
      delete out.oneOf
    }
    if (!declaresArray(out)) {
      appendHint(out, `Accepts anyOf: ${branches.map((b) => summarizeSchema(b)).join(" | ")}`)
    }
    return out
  }

  if (nonNull.every(isObjectBranch)) {
    const rest = { ...out }
    delete rest[key]
    return intersectSchemas([rest, unionObjectBranches(nonNull.filter((b): b is JsonSchema => isObject(b)), hasNull)])
  }

  const family = primitiveFamily(nonNull)
  if (family) {
    const rest = { ...out }
    delete rest[key]
    return intersectSchemas([rest, unionPrimitiveBranches(nonNull.filter((b): b is JsonSchema => isObject(b)), family, hasNull)])
  }

  if (key === "oneOf") {
    const current = out.anyOf
    out.anyOf = Array.isArray(current) ? [...current, ...branches] : branches
    delete out.oneOf
  }
  appendHint(out, `Accepts anyOf: ${branches.map((b) => summarizeSchema(b)).join(" | ")}`)
  return out
}

function constConflict(out: JsonSchema): void {
  if (!Array.isArray(out.enum)) return
  if (!out.enum.includes(out.const)) {
    appendHint(out, `Conflicting const and enum constraints; const is ${JSON.stringify(out.const)}.`)
  }
  delete out.enum
}

// `const` on a leaf. Non-empty strings become a one-value enum; `""`, numbers,
// booleans, objects and arrays keep `const` (sanitizeInputSchema turns it into
// a "Must equal" hint) and get the matching type.
function lowerConst(out: JsonSchema): void {
  const value = out.const
  if (value === null) {
    delete out.const
    if (isNullType(out.type)) delete out.type
    appendHint(out, NULL_HINT)
    return
  }
  if (typeof value === "string") {
    const types = typeList(out.type)
    if (types && !types.every((t) => t === "string" || t === "null")) return
    // `const` already excludes null, so a nullable string type narrows to string.
    out.type = "string"
    if (!value.length) {
      constConflict(out)
      return
    }
    if (Array.isArray(out.enum) && !out.enum.includes(value)) {
      appendHint(out, `Conflicting const and enum constraints; const is ${JSON.stringify(value)}.`)
    }
    out.enum = [value]
    delete out.const
    return
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    out.type ??= Number.isInteger(value) ? "integer" : "number"
    constConflict(out)
  } else if (typeof value === "boolean") {
    out.type ??= "boolean"
    constConflict(out)
  } else if (Array.isArray(value)) {
    out.type ??= "array"
  } else if (isObject(value)) {
    out.type ??= "object"
  }
}

interface CacheEntry {
  schema: JsonSchema
  weight: number
  bytes: number
  height: number
}

interface MeasureResult {
  schema: JsonSchema
  weight: number
  bytes: number
  nested: number
  nestedBytes: number
  limited: boolean
  height: number
}

export function expandToolSchema(root: JsonSchema): JsonSchema {
  if (!isObject(root)) return root

  // Cycle-free `$ref` targets are expanded once and deep-cloned on reuse.
  const cache = new Map<unknown, CacheEntry>()
  let produced = 0 // schema objects emitted, including cached copies
  let producedBytes = 0 // estimated JSON bytes emitted, including cached copies
  let inlined = 0 // of those, nodes emitted through $ref / allOf expansion
  let inlinedBytes = 0 // of those, bytes emitted through $ref / allOf expansion
  let limits = 0 // recursion / depth / budget fallbacks emitted
  let deepest = 0

  function limit(schema: unknown, hint: string): JsonSchema {
    const out = structuralFallback(schema, hint)
    limits++
    produced++
    producedBytes += ownBytes(out)
    return out
  }

  function measure(inlineDepth: number, fn: () => JsonSchema): MeasureResult {
    const start = { produced, producedBytes, inlined, inlinedBytes, limits, deepest }
    deepest = inlineDepth
    const schema = fn()
    const result = {
      schema,
      weight: produced - start.produced,
      bytes: producedBytes - start.producedBytes,
      nested: inlined - start.inlined,
      nestedBytes: inlinedBytes - start.inlinedBytes,
      limited: limits !== start.limits,
      height: deepest - inlineDepth,
    }
    deepest = Math.max(start.deepest, deepest)
    // Charge only what nested expansions have not charged already.
    inlined += Math.max(0, result.weight - result.nested)
    inlinedBytes += Math.max(0, result.bytes - result.nestedBytes)
    return result
  }

  function expandRef(target: unknown, inlineDepth: number, active: Set<unknown>): JsonSchema {
    if (typeof target === "boolean") return visit(target, inlineDepth, active)
    if (inlined >= MAX_INLINED_NODES || inlinedBytes >= MAX_INLINED_BYTES) return limit(target, LIMIT_HINT)
    const hit = cache.get(target)
    if (hit && inlineDepth + hit.height <= MAX_DEPTH) {
      if (inlined + hit.weight > MAX_INLINED_NODES || inlinedBytes + hit.bytes > MAX_INLINED_BYTES) {
        return limit(target, LIMIT_HINT)
      }
      produced += hit.weight
      inlined += hit.weight
      producedBytes += hit.bytes
      inlinedBytes += hit.bytes
      deepest = Math.max(deepest, inlineDepth + hit.height)
      return structuredClone(hit.schema)
    }
    const result = measure(inlineDepth, () => visit(target, inlineDepth, active))
    if (!result.limited) {
      cache.set(target, {
        schema: structuredClone(result.schema),
        weight: result.weight,
        bytes: result.bytes,
        height: result.height,
      })
    }
    return result.schema
  }

  function visit(schema: unknown, inlineDepth: number, active: Set<unknown>): JsonSchema {
    deepest = Math.max(deepest, inlineDepth)
    if (!isObject(schema)) {
      const out: JsonSchema = { description: schema === false ? NO_VALUE_HINT : ANY_VALUE_HINT }
      produced++
      producedBytes += ownBytes(out)
      return out
    }
    if (active.has(schema)) return limit(schema, RECURSIVE_HINT)
    if (inlineDepth > MAX_DEPTH) return limit(schema, LIMIT_HINT)
    produced++
    const nextActive = new Set(active).add(schema)
    const child = (value: unknown): JsonSchema => visit(value, inlineDepth, nextActive)

    let out: JsonSchema = {}
    for (const [key, value] of Object.entries(schema)) {
      if (key === "$defs" || key === "definitions" || key === "$schema" || key === "$id" ||
          key === "$ref" || key === "allOf") continue
      out[key] = value
    }

    if (out.const !== undefined) lowerConst(out)

    for (const mapKey of CONTAINER_MAPS) {
      const current = out[mapKey]
      if (isObject(current)) {
        out[mapKey] = Object.fromEntries(Object.entries(current).map(([k, v]) => [k, child(v)]))
      }
    }
    for (const childKey of BOOLEAN_OR_SCHEMA_CHILDREN) {
      const current = out[childKey]
      if (isObject(current)) {
        out[childKey] = child(current)
      }
    }
    for (const childKey of SCHEMA_ONLY_CHILDREN) {
      const current = out[childKey]
      if (current !== undefined && (isObject(current) || typeof current === "boolean")) {
        out[childKey] = child(current)
      }
    }
    if (Array.isArray(out.prefixItems)) {
      out.prefixItems = out.prefixItems.map((item) => child(item))
    }
    if (Array.isArray(out.items)) {
      out.items = out.items.map((item) => child(item))
    } else if (isObject(out.items)) {
      out.items = child(out.items)
    } else if (out.items === false) {
      if (Array.isArray(out.prefixItems) && out.prefixItems.length > 0) {
        // A closed tuple. agy ignores prefixItems, so give it the element
        // union and the tuple length instead of forbidding every element.
        const length = out.prefixItems.length
        out.maxItems = typeof out.maxItems === "number" ? Math.min(out.maxItems, length) : length
        out.items = structuredClone(unionPropertySchemas(out.prefixItems))
      } else {
        out.maxItems = 0
        out.items = { type: "string", description: NO_VALUE_HINT }
      }
    }
    for (const key of ["anyOf", "oneOf"]) {
      const branches = out[key]
      if (Array.isArray(branches)) out[key] = branches.map((branch) => child(branch))
    }

    if (typeof schema.$ref === "string") {
      const target = resolvePointer(root, schema.$ref)
      if (target !== undefined) {
        out = intersectSchemas([out, expandRef(target, inlineDepth + 1, nextActive)])
      } else {
        appendHint(out, `Unresolved schema reference: ${schema.$ref}`)
      }
    }

    if (Array.isArray(schema.allOf) && schema.allOf.length) {
      const branches = schema.allOf.map((branch) => {
        if (inlined >= MAX_INLINED_NODES || inlinedBytes >= MAX_INLINED_BYTES) {
          return limit(branch, LIMIT_HINT)
        }
        return measure(inlineDepth + 1, () => visit(branch, inlineDepth + 1, nextActive)).schema
      })
      out = intersectSchemas([out, ...branches])
    }

    out = lowerUnionKey(out, "oneOf")
    out = lowerUnionKey(out, "anyOf")

    if (out.additionalProperties === true) {
      appendHint(out, "Accepts arbitrary additional key-value properties.")
    } else if (isObject(out.additionalProperties)) {
      appendHint(out, `Additional properties: ${summarizeSchema(out.additionalProperties)}`)
    }
    if (isObject(out.patternProperties) && Object.keys(out.patternProperties).length > 0) {
      const shown = Object.entries(out.patternProperties)
        .slice(0, 6)
        .map(([pat, val]) => `${pat}: ${summarizeSchema(val)}`)
      appendHint(out, `Pattern properties: ${shown.join(", ")}`)
    }

    producedBytes += ownBytes(out)
    return out
  }

  return visit(root, 0, new Set())
}

function sanitizeNode(schema: unknown): unknown {
  if (!isObject(schema)) return schema
  const out: JsonSchema = { ...schema }

  if (Array.isArray(out.type)) {
    const types = out.type.filter((item): item is string => typeof item === "string")
    const nullable = types.includes("null")
    const nonNull = types.filter((item) => item !== "null")
    if (nonNull.length > 1) {
      let chosen = nonNull[0] ?? "object"
      if (nonNull.includes("array") && out.items !== undefined) chosen = "array"
      else if (nonNull.includes("object") && (out.properties !== undefined || out.additionalProperties !== undefined)) {
        chosen = "object"
      }
      out.type = nullable ? [chosen, "null"] : chosen
      appendHint(out, `Accepts types: ${types.join(" | ")}`)
    } else if (nonNull.length === 1) {
      out.type = nullable ? [nonNull[0], "null"] : nonNull[0]
    }
  }

  const resolvedType = typeof out.type === "string"
    ? out.type
    : Array.isArray(out.type)
      ? out.type.find((item) => item !== "null") ?? null
      : null

  if (resolvedType && resolvedType !== "array") {
    delete out.items
    delete out.prefixItems
    delete out.minItems
    delete out.maxItems
    delete out.uniqueItems
    delete out.contains
  }
  if (resolvedType && resolvedType !== "object") {
    delete out.properties
    delete out.patternProperties
    delete out.required
    delete out.minProperties
    delete out.maxProperties
    delete out.dependentRequired
  }

  if (Array.isArray(out.enum)) {
    const invalidEnum = out.enum.length === 0 ||
      (Boolean(resolvedType) && resolvedType !== "string") ||
      out.enum.some((item) => typeof item !== "string" || item.length === 0)
    if (invalidEnum) {
      if (out.enum.length) {
        appendHint(out, `Allowed values: ${out.enum.map((item) => JSON.stringify(item)).join(", ")}`)
      }
      delete out.enum
    }
  }

  if (out.const !== undefined && (typeof out.const !== "string" || out.const.length === 0 || (Boolean(resolvedType) && resolvedType !== "string"))) {
    appendHint(out, `Must equal: ${JSON.stringify(out.const)}`)
    delete out.const
  }

  if (isObject(out.properties)) {
    out.properties = Object.fromEntries(
      Object.entries(out.properties).map(([key, value]) => [key, sanitizeNode(value)]),
    )
    if (Array.isArray(out.required)) {
      const properties = isObject(out.properties) ? out.properties : {}
      const filtered = out.required.filter((key) => typeof key === "string" && Object.hasOwn(properties, key))
      if (filtered.length) out.required = filtered
      else delete out.required
    }
  }
  if (isObject(out.patternProperties)) {
    out.patternProperties = Object.fromEntries(
      Object.entries(out.patternProperties).map(([key, value]) => [key, sanitizeNode(value)]),
    )
  }
  if (isObject(out.additionalProperties)) {
    out.additionalProperties = sanitizeNode(out.additionalProperties)
  }
  if (Array.isArray(out.items)) {
    out.items = out.items.map((item) => sanitizeNode(item))
  } else if (isObject(out.items)) {
    out.items = sanitizeNode(out.items)
  }
  if (Array.isArray(out.prefixItems)) {
    out.prefixItems = out.prefixItems.map((item) => sanitizeNode(item))
  }
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const branches = out[key]
    if (Array.isArray(branches)) out[key] = branches.map((item) => sanitizeNode(item))
  }
  if (isObject(out.not)) {
    out.not = sanitizeNode(out.not)
  }
  for (const defsKey of ["$defs", "definitions"]) {
    const defs = out[defsKey]
    if (isObject(defs)) {
      out[defsKey] = Object.fromEntries(
        Object.entries(defs).map(([key, value]) => [key, sanitizeNode(value)]),
      )
    }
  }
  for (const key of ["propertyNames", "contains", "if", "then", "else", "unevaluatedProperties", "unevaluatedItems"]) {
    const current = out[key]
    if (isObject(current)) {
      out[key] = sanitizeNode(current)
    }
  }
  if (isObject(out.dependentSchemas)) {
    out.dependentSchemas = Object.fromEntries(
      Object.entries(out.dependentSchemas).map(([key, value]) => [key, sanitizeNode(value)]),
    )
  }
  // agy (Go/RE2) will reject the whole toolbox if any pattern is only valid as
  // ECMA-262. Translate or drop those patterns here; tool-call arguments in
  // the response are plain JSON and do not need a reverse transform.
  sanitizePatternFields(out)
  return out
}

// Sanitize JSON Schema constructs that agy's ACP -> Google Code Assist translator
// converts into invalid Schema protos (e.g. union types leaving stale array/object
// keywords, or non-string/empty enum entries producing `enum[0]: cannot be empty`).
export function sanitizeInputSchema(schema: unknown): JsonSchema {
  const result = sanitizeNode(schema)
  return isObject(result) ? result : {}
}

// agy rejects the whole toolbox when the root schema's `type` is not "object"
// (`schema root "type" must be "object"`). A root that only declares
// `oneOf` / `anyOf` / `allOf` has no type of its own, so flatten the object
// branches into the root instead of leaving a combinator there.
function foldRootToObject(root: JsonSchema): JsonSchema {
  const declared = typeList(root.type)
  if (declared && declared.includes("object")) return root

  const rawAllOf = Array.isArray(root.allOf) ? root.allOf : []
  const rawAnyOf = Array.isArray(root.anyOf) ? root.anyOf : []
  const rawOneOf = Array.isArray(root.oneOf) ? root.oneOf : []
  if (!rawAllOf.length && !rawAnyOf.length && !rawOneOf.length) return root

  let out: JsonSchema = { ...root }
  delete out.anyOf
  delete out.oneOf
  delete out.allOf
  delete out.type

  const allOf = rawAllOf.filter((branch): branch is JsonSchema => isObject(branch))
  if (allOf.length) out = intersectSchemas([out, ...allOf])

  const alternatives = [...rawAnyOf, ...rawOneOf].filter((branch) => isObjectBranch(branch) && isObject(branch))
  if (alternatives.length) {
    out = intersectSchemas([out, unionObjectBranches(alternatives as JsonSchema[], false)])
  }

  if (!typeList(out.type)?.includes("object")) out.type = "object"
  if (!isObject(out.properties)) out.properties = {}
  else {
    // Keep only required keys that survived the fold.
    const properties = out.properties
    if (Array.isArray(out.required)) {
      const filtered = out.required.filter((key) => typeof key === "string" && Object.hasOwn(properties, key))
      if (filtered.length) out.required = filtered
      else delete out.required
    }
  }
  return out
}

// Last line of defense: agy requires an object at the schema root.
function ensureObjectRoot(schema: JsonSchema): JsonSchema {
  const declared = typeList(schema.type)
  if (!declared) {
    const out: JsonSchema = { ...schema, type: "object" }
    if (!isObject(out.properties)) out.properties = {}
    return out
  }
  if (declared.includes("object")) {
    // `type: ["object", "null"]` is still an array at the root; agy wants the
    // string form. Null tool input is not expressible anyway.
    if (declared.length === 1) return schema
    return { ...schema, type: "object" }
  }
  // The caller declared a non-object root. agy cannot express that as a tool
  // input schema, so keep the description trail and fall back to an object.
  const out: JsonSchema = { ...schema, type: "object", properties: {} }
  delete out.enum
  delete out.const
  delete out.items
  delete out.prefixItems
  delete out.minItems
  delete out.maxItems
  delete out.minLength
  delete out.maxLength
  delete out.minimum
  delete out.maximum
  delete out.format
  delete out.pattern
  appendHint(out, `Original schema root type was ${declared.join("|")}; agy requires an object root.`)
  return out
}

/**
 * Full Gemini-compatible sanitizer pipeline used for every declared tool:
 * `$ref`/`allOf`/union expansion, root object folding, type/enum/pattern
 * normalization, and array `items` filling.
 */
export function sanitizeToolInputSchema(raw: unknown): JsonSchema {
  const root: JsonSchema = isObject(raw) ? (structuredClone(raw) as JsonSchema) : { type: "object", properties: {} }
  const expanded = expandToolSchema(root)
  const folded = foldRootToObject(expanded)
  const sanitized = sanitizeInputSchema(folded)
  const withItems = ensureGeminiArrayItems(sanitized)
  return ensureObjectRoot(withItems)
}

const MCP_NAME_RE = /^[A-Za-z0-9_-]{1,50}$/
const MCP_HASH_SUFFIX_RE = /_[0-9a-f]{8}$/
const MAX_MCP_NAME_LENGTH = 50
const MCP_HASH_LENGTH = 8
const MCP_CORE_LENGTH = MAX_MCP_NAME_LENGTH - MCP_HASH_LENGTH - 1

function hashToolName(originalName: string): string {
  return createHash("sha256").update(originalName).digest("hex").slice(0, MCP_HASH_LENGTH)
}

function toolNameCore(originalName: string, maxLength = MCP_CORE_LENGTH): string {
  const cleaned = originalName.replace(/[^A-Za-z0-9_-]/g, "_")
  const truncated = cleaned.slice(0, Math.max(1, maxLength))
  return truncated.length ? truncated : "tool"
}

/**
 * Deterministic MCP-safe tool name. Names that are already valid and do not
 * look like a previous hash suffix are kept verbatim; everything else is
 * sanitized, truncated, and suffixed with 8 hex chars of SHA-256 so `a.b` and
 * `a_b` can never collide. `agy` exposes these as `mcp_magpie_<mcpName>`.
 */
export function toMcpToolName(originalName: string): string {
  if (MCP_NAME_RE.test(originalName) && !MCP_HASH_SUFFIX_RE.test(originalName)) return originalName
  return `${toolNameCore(originalName)}_${hashToolName(originalName)}`
}

function uniqueMcpToolName(originalName: string, taken: Map<string, string>): string {
  let candidate = toMcpToolName(originalName)
  let attempt = 1
  while (taken.has(candidate)) {
    const digits = String(attempt).length
    const core = toolNameCore(originalName, MCP_CORE_LENGTH - digits - 1)
    candidate = `${core}_${attempt}_${hashToolName(originalName)}`
    attempt++
  }
  return candidate
}

export interface NormalizedToolSet {
  tools: NormalizedToolDef[]
  mcpToOriginal: Map<string, string>
  originalToMcp: Map<string, string>
}

export function normalizeToolDefinitions(
  rawTools: NormalizedAnthropicRequest["tools"],
): NormalizedToolSet {
  const tools: NormalizedToolDef[] = []
  const mcpToOriginal = new Map<string, string>()
  const originalToMcp = new Map<string, string>()

  for (const raw of rawTools) {
    const originalName = typeof raw?.name === "string" ? raw.name : ""
    if (!originalName) continue
    if (originalToMcp.has(originalName)) continue
    const mcpName = uniqueMcpToolName(originalName, mcpToOriginal)
    const description = typeof raw.description === "string" ? raw.description : ""
    const inputSchema = sanitizeToolInputSchema(raw.inputSchema)
    mcpToOriginal.set(mcpName, originalName)
    originalToMcp.set(originalName, mcpName)
    tools.push({ originalName, mcpName, description, inputSchema })
  }

  return { tools, mcpToOriginal, originalToMcp }
}
