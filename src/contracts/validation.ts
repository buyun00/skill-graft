export const P2_JSON_SCHEMA_DRAFT = 'https://json-schema.org/draft/2020-12/schema' as const

export const P2_VALIDATION_ERROR_CODES = [
  'INVALID_TYPE',
  'MISSING_FIELD',
  'UNEXPECTED_FIELD',
  'UNSUPPORTED_SCHEMA_VERSION',
  'INVALID_VALUE',
  'INVALID_IDENTIFIER',
  'DUPLICATE_VALUE',
  'PATH_NOT_NORMALIZED',
  'PATH_COLLISION',
  'REFERENCE_NOT_FOUND',
  'INVARIANT_VIOLATION'
] as const

export type P2ValidationErrorCode = (typeof P2_VALIDATION_ERROR_CODES)[number]

export type P2ValidationError = {
  code: P2ValidationErrorCode
  path: string
  message: string
}

export type P2ValidationResult<T> =
  | { valid: true; value: T; errors: readonly [] }
  | { valid: false; errors: readonly P2ValidationError[] }

/** JSON Schema 2020-12 compatible data. Kept host-neutral for both releases. */
export type ContractJsonSchema = Readonly<Record<string, unknown>>

/**
 * Host-neutral identifiers may describe a logical kind (for example
 * `worktree:<digest>`) but can never contain a filesystem separator, drive
 * prefix, whitespace, or a control character. The 256-character ceiling is
 * shared by every P2 persisted opaque-identity field.
 */
export const PORTABLE_OPAQUE_IDENTIFIER_PATTERN =
  '^(?![A-Za-z]:)(?![\\s\\S]*[\\u0000-\\u0020\\u007f/\\\\])[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$' as const

/** JSON-Schema prefilter; semantic segment checks are applied after parsing. */
export const PORTABLE_RELATIVE_PATH_PATTERN =
  '^(?![A-Za-z]:)(?!/)(?![\\s\\S]*[\\u0000-\\u001f\\u007f\\\\]).+$' as const

const PORTABLE_OPAQUE_IDENTIFIER = new RegExp(PORTABLE_OPAQUE_IDENTIFIER_PATTERN, 'u')

function wellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false
    }
  }
  return true
}

function windowsReservedBasename(segment: string): boolean {
  const basename = segment.split('.', 1)[0].toLocaleUpperCase('en-US')
  return /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(basename)
}

export function isPortableOpaqueIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= 256
    && wellFormedUnicode(value)
    && PORTABLE_OPAQUE_IDENTIFIER.test(value)
}

export function isPortableRelativePath(value: unknown): value is string {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > 4096
    || value !== value.trim()
    || !wellFormedUnicode(value)
    || value !== value.normalize('NFC')
    || value.includes('\\')
    || /^[A-Za-z]:|^\//u.test(value)) return false
  return value.split('/').every((segment) => segment.length > 0
    && segment.length <= 255
    && segment !== '.'
    && segment !== '..'
    && !/[<>"|?*\u0000-\u001f\u007f:]/u.test(segment)
    && !/[ .]$/u.test(segment)
    && !windowsReservedBasename(segment))
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function childPath(parent: string, key: string | number): string {
  return typeof key === 'number' ? `${parent}[${key}]` : `${parent}.${key}`
}

function error(
  errors: P2ValidationError[],
  code: P2ValidationErrorCode,
  path: string,
  message: string
): void {
  errors.push({ code, path, message })
}

function matchesType(value: unknown, expected: string): boolean {
  if (expected === 'null') return value === null
  if (expected === 'array') return Array.isArray(value)
  if (expected === 'object') return isRecord(value)
  if (expected === 'integer') return typeof value === 'number' && Number.isInteger(value)
  return typeof value === expected
}

function equalJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => equalJson(value, right[index]))
  }
  if (!isRecord(left) || !isRecord(right)) return false
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => Object.hasOwn(right, key) && equalJson(left[key], right[key]))
}

function validateFormat(value: string, format: unknown): boolean {
  if (format !== 'date-time') return true
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false
  const epoch = Date.parse(value)
  if (!Number.isFinite(epoch)) return false
  const normalized = new Date(epoch).toISOString()
  return normalized === (value.includes('.') ? value : value.replace(/Z$/u, '.000Z'))
}

function schemaCode(schema: ContractJsonSchema): P2ValidationErrorCode {
  const explicit = schema['x-errorCode']
  return typeof explicit === 'string' && P2_VALIDATION_ERROR_CODES.includes(explicit as P2ValidationErrorCode)
    ? explicit as P2ValidationErrorCode
    : 'INVALID_VALUE'
}

function validateValue(
  value: unknown,
  schema: ContractJsonSchema,
  path: string,
  errors: P2ValidationError[]
): void {
  const expectedType = schema.type
  if (typeof expectedType === 'string' || Array.isArray(expectedType)) {
    const allowed = typeof expectedType === 'string' ? [expectedType] : expectedType
    if (!allowed.some((entry) => typeof entry === 'string' && matchesType(value, entry))) {
      error(errors, 'INVALID_TYPE', path, `expected ${allowed.join(' or ')}`)
      return
    }
  }

  if (Object.hasOwn(schema, 'const') && !equalJson(value, schema.const)) {
    const code = path.endsWith('.schemaVersion') ? 'UNSUPPORTED_SCHEMA_VERSION' : schemaCode(schema)
    error(errors, code, path, `expected constant ${String(schema.const)}`)
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => equalJson(entry, value))) {
    error(errors, schemaCode(schema), path, 'value is not in the allowed vocabulary')
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      error(errors, schemaCode(schema), path, `must contain at least ${schema.minLength} characters`)
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      error(errors, schemaCode(schema), path, `must contain at most ${schema.maxLength} characters`)
    }
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) {
      error(errors, schemaCode(schema), path, 'value does not match the required pattern')
    }
    if (!validateFormat(value, schema.format)) {
      error(errors, 'INVALID_VALUE', path, 'value must be an RFC 3339 UTC date-time')
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      error(errors, schemaCode(schema), path, `must be at least ${schema.minimum}`)
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      error(errors, schemaCode(schema), path, `must be at most ${schema.maximum}`)
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      error(errors, schemaCode(schema), path, `must contain at least ${schema.minItems} items`)
    }
    if (schema.uniqueItems === true) {
      for (let index = 0; index < value.length; index += 1) {
        if (value.slice(0, index).some((entry) => equalJson(entry, value[index]))) {
          error(errors, 'DUPLICATE_VALUE', childPath(path, index), 'array values must be unique')
        }
      }
    }
    if (isRecord(schema.items)) {
      value.forEach((entry, index) => validateValue(entry, schema.items as ContractJsonSchema, childPath(path, index), errors))
    }
  }

  if (!isRecord(value)) return
  const properties = isRecord(schema.properties) ? schema.properties : {}
  const required = Array.isArray(schema.required)
    ? schema.required.filter((entry): entry is string => typeof entry === 'string')
    : []
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      error(errors, 'MISSING_FIELD', childPath(path, key), 'required field is missing')
    }
  }
  for (const [key, entry] of Object.entries(value)) {
    const propertySchema = properties[key]
    if (isRecord(propertySchema)) {
      validateValue(entry, propertySchema, childPath(path, key), errors)
      continue
    }
    const additional = schema.additionalProperties
    if (additional === false) {
      error(errors, 'UNEXPECTED_FIELD', childPath(path, key), 'field is not declared by this contract')
    } else if (isRecord(additional)) {
      validateValue(entry, additional, childPath(path, key), errors)
    }
  }
}

export function validateAgainstContractSchema<T>(
  value: unknown,
  schema: ContractJsonSchema
): P2ValidationResult<T> {
  const errors: P2ValidationError[] = []
  validateValue(value, schema, '$', errors)
  return errors.length === 0
    ? { valid: true, value: value as T, errors: [] }
    : { valid: false, errors }
}

export function invalidValidation<T>(errors: readonly P2ValidationError[]): P2ValidationResult<T> {
  return { valid: false, errors }
}
