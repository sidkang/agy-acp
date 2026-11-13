// Fill a sibling `items` on array JSON Schemas so Gemini function_declarations
// are not rejected with `items: missing field`. Called as a tree walk after
// sanitizeInputSchema, so this module does not have to live inside that
// function (the RE2 PR also edits the end of sanitizeInputSchema).
//
// Ported from the MIT-licensed agy-cli bridge (see LICENSE).

type SchemaNode = Record<string, unknown>

function isSchemaNode(value: unknown): value is SchemaNode {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function appendSchemaHint(node: SchemaNode, hint: string): void {
  if (!hint) return
  if (typeof node.description === "string" && node.description.trim()) {
    if (!node.description.includes(hint)) node.description = `${node.description} (${hint})`
  } else {
    node.description = hint
  }
}

function nodeDeclaresArray(node: unknown): node is SchemaNode {
  if (!isSchemaNode(node)) return false
  if (typeof node.type === "string") return node.type === "array"
  if (Array.isArray(node.type)) return node.type.includes("array")
  return false
}

function typelessItems(items: unknown): boolean {
  if (items == null || items === true) return true
  if (items === false) return false
  if (Array.isArray(items)) return false
  if (!isSchemaNode(items)) return true
  if (typeof items.$ref === "string" && items.$ref) return false
  if (typeof items.type === "string" && items.type) return false
  if (Array.isArray(items.type) && items.type.length) return false
  return !items.anyOf && !items.oneOf && !items.allOf
}

function cloneSchemaNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map((item) => cloneSchemaNode(item))
  if (node && typeof node !== "object") return node
  if (isSchemaNode(node)) return { ...node }
  return node
}

function branchCanAcceptArray(branch: unknown): boolean {
  if (branch == null || branch === false) return false
  if (branch === true) return true
  if (!isSchemaNode(branch)) return false
  if (typeof branch.type === "string") return branch.type === "array"
  if (Array.isArray(branch.type)) return branch.type.includes("array")
  // Typeless schemas, including {}, accept arrays. Object-only keywords still
  // accept non-objects in JSON Schema unless type is set, but a missing type
  // must not be treated as "not an array" or an anyOf [{}] would be ignored.
  return true
}

function itemsFromCombinators(node: SchemaNode): SchemaNode | null {
  const collected: unknown[] = []
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    const branches = node[key]
    if (!Array.isArray(branches)) continue
    let openArray = false
    const definite: unknown[] = []
    for (const branch of branches) {
      if (!branchCanAcceptArray(branch)) continue
      if (!isSchemaNode(branch)) continue
      if (Array.isArray(branch.items)) continue
      // An anyOf/oneOf alternative that accepts any array must not let a
      // sibling's items become a global constraint (e.g. string items next to
      // {} would reject [1]). allOf alternatives all apply, so typeless ones
      // do not loosen the others.
      if (typelessItems(branch.items)) {
        if (key !== "allOf") openArray = true
        continue
      }
      definite.push(cloneSchemaNode(branch.items))
    }
    if (openArray) return null
    collected.push(...definite)
  }
  if (!collected.length) return null
  const unique: unknown[] = []
  const seen = new Set<string>()
  for (const item of collected) {
    const sig = JSON.stringify(item)
    if (seen.has(sig)) continue
    seen.add(sig)
    unique.push(item)
  }
  if (unique.length === 1) return unique[0] as SchemaNode
  return { anyOf: unique }
}

function inferItemsFromExisting(existing: SchemaNode): SchemaNode | null {
  // Do not stamp type:"object" onto a properties-only items schema: JSON Schema
  // would then reject non-object values that were previously allowed.
  if (existing.properties || existing.additionalProperties !== undefined) {
    return { ...existing }
  }
  if (Array.isArray(existing.enum) && existing.enum.length && !existing.type) {
    const samples = existing.enum.filter((item) => item !== null && item !== undefined)
    if (!samples.length) return null
    const types = new Set(
      samples.map((sample) =>
        typeof sample === "boolean" ? "boolean"
          : typeof sample === "number" ? (Number.isInteger(sample) ? "integer" : "number")
            : "string"),
    )
    if (types.has("number") && types.has("integer")) types.delete("integer")
    if (types.size !== 1) return null
    const only = [...types][0]
    if (only === undefined) return null
    return { ...existing, type: only }
  }
  return null
}

export const PERMISSIVE_LEAF_TYPES = ["string", "number", "integer", "boolean", "object", "null"] as const
// Gemini Schema cannot express an unbounded nested array without $ref, which
// the translator may not honor. Eight levels is enough for tool arguments and
// is idempotent because the innermost array already has typed items.
export const PERMISSIVE_ARRAY_DEPTH = 8
const TUPLE_ITEMS_HINT = "tuple items were left as a list; positional tuples may not be honored"
const UNTYPED_ITEMS_HINT = "array items were untyped; a permissive items schema was added"

function leafSchemas(): SchemaNode[] {
  return PERMISSIVE_LEAF_TYPES.map((type) => ({ type }))
}

function permissiveValueSchema(depth: number): SchemaNode {
  const leaves = leafSchemas()
  if (depth <= 1) {
    return { anyOf: [...leaves, { type: "array", items: { anyOf: leaves.map((item) => ({ ...item })) } }] }
  }
  return { anyOf: [...leaves, { type: "array", items: permissiveValueSchema(depth - 1) }] }
}

function permissiveItemSchema(existing: SchemaNode = {}): SchemaNode {
  return { ...existing, ...permissiveValueSchema(PERMISSIVE_ARRAY_DEPTH) }
}

function mergeItems(fromCombo: SchemaNode, existing: SchemaNode): SchemaNode {
  if (!existing || Object.keys(existing).length === 0) return fromCombo
  // Keep constraints already on the typeless items node (e.g. maxLength).
  return { ...fromCombo, ...existing }
}

function fillGeminiArrayItems(node: SchemaNode): void {
  if (!nodeDeclaresArray(node)) return
  if (Array.isArray(node.items)) {
    appendSchemaHint(node, TUPLE_ITEMS_HINT)
    return
  }
  const existing: SchemaNode = isSchemaNode(node.items) ? { ...node.items } : {}
  if (Array.isArray(node.prefixItems)) {
    appendSchemaHint(node, TUPLE_ITEMS_HINT)
    if (!typelessItems(node.items)) return
    // prefixItems alone still leaves sibling items missing; fill a rest schema.
    const fromCombo = itemsFromCombinators(node)
    if (fromCombo) node.items = mergeItems(fromCombo, existing)
    else {
      const inferred = inferItemsFromExisting(existing)
      node.items = inferred ?? permissiveItemSchema(existing)
      if (!inferred) appendSchemaHint(node, UNTYPED_ITEMS_HINT)
    }
    return
  }
  if (!typelessItems(node.items)) return
  const fromCombo = itemsFromCombinators(node)
  if (fromCombo) {
    node.items = mergeItems(fromCombo, existing)
    return
  }
  const inferred = inferItemsFromExisting(existing)
  if (inferred) {
    node.items = inferred
    return
  }
  node.items = permissiveItemSchema(existing)
  appendSchemaHint(node, UNTYPED_ITEMS_HINT)
}

const SCHEMA_CHILD_KEYS = [
  "additionalProperties", "propertyNames", "contains", "if", "then", "else",
  "not", "unevaluatedProperties", "unevaluatedItems", "items",
] as const
const SCHEMA_ARRAY_KEYS = ["anyOf", "oneOf", "allOf", "prefixItems"] as const
const SCHEMA_MAP_KEYS = ["properties", "patternProperties", "dependentSchemas", "$defs", "definitions"] as const

function walk(node: unknown): void {
  if (!node || typeof node !== "object") return
  if (Array.isArray(node)) {
    for (const item of node) walk(item)
    return
  }
  const schema = node as SchemaNode
  // Children first so combinator branches are filled before we copy items up.
  for (const key of SCHEMA_CHILD_KEYS) walk(schema[key])
  for (const key of SCHEMA_ARRAY_KEYS) {
    const branches = schema[key]
    if (Array.isArray(branches)) for (const item of branches) walk(item)
  }
  for (const key of SCHEMA_MAP_KEYS) {
    const map = schema[key]
    if (map && typeof map === "object" && !Array.isArray(map)) {
      for (const child of Object.values(map)) walk(child)
    }
  }
  fillGeminiArrayItems(schema)
}

// Mutates and returns the schema tree so callers can write
// `ensureGeminiArrayItems(sanitizeInputSchema(raw))`.
export function ensureGeminiArrayItems<T>(node: T): T {
  walk(node)
  return node
}
