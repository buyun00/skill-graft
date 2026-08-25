import type { ContractVersion } from './version.js'

export type JsonPrimitive = string | number | boolean | null

export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[]

export type JsonObject = {
  readonly [key: string]: JsonValue
}

export type CommandMeta = {
  contractVersion: ContractVersion
  requestId: string
  hostId: string
  transport: string
}
