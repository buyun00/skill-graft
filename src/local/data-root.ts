import path from 'node:path'

export const PRIMARY_DATA_ROOT_ENV = 'SKILL_GRAFT_HOME'
export const LEGACY_DATA_ROOT_ENV = 'HUB_ROOT'

export type LocalDataRootEnvironment = Readonly<{
  SKILL_GRAFT_HOME?: string
  HUB_ROOT?: string
}>

export type ResolveLocalDataRootOptions = {
  /** Package root used only when neither environment name nor an explicit root is provided. */
  packageRoot: string
  /** Internal callers may pin a root, but an inherited environment conflict is still rejected first. */
  dataRoot?: string
  environment?: LocalDataRootEnvironment
  platform?: NodeJS.Platform | string
  cwd?: string
}

export class LocalDataRootError extends Error {
  readonly code: 'INVALID_DATA_ROOT' | 'DATA_ROOT_CONFLICT'

  constructor(code: LocalDataRootError['code'], message: string) {
    super(message)
    this.name = 'LocalDataRootError'
    this.code = code
  }
}

/**
 * Resolve the Local-host data root without touching the filesystem.
 *
 * SKILL_GRAFT_HOME is authoritative and HUB_ROOT is its compatibility alias.
 * Supplying both is allowed only when their platform-aware lexical resolutions
 * identify the same root. This check deliberately precedes the explicit-root
 * override so public adapters cannot accidentally hide a hostile environment.
 */
export function resolveLocalDataRoot(options: ResolveLocalDataRootOptions): string {
  const platform = options.platform || process.platform
  const cwd = options.cwd || process.cwd()
  const environment = options.environment || process.env
  const primary = optionalRoot(environment.SKILL_GRAFT_HOME, PRIMARY_DATA_ROOT_ENV, platform, cwd)
  const legacy = optionalRoot(environment.HUB_ROOT, LEGACY_DATA_ROOT_ENV, platform, cwd)

  if (primary && legacy && comparableRoot(primary, platform) !== comparableRoot(legacy, platform)) {
    throw new LocalDataRootError(
      'DATA_ROOT_CONFLICT',
      `${PRIMARY_DATA_ROOT_ENV} and ${LEGACY_DATA_ROOT_ENV} resolve to different data roots`
    )
  }

  if (options.dataRoot !== undefined) {
    return requiredRoot(options.dataRoot, 'dataRoot', platform, cwd)
  }
  if (primary) return primary
  if (legacy) return legacy
  return requiredRoot(options.packageRoot, 'packageRoot', platform, cwd)
}

export function localDataRootsEqual(
  left: string,
  right: string,
  platform: NodeJS.Platform | string = process.platform,
  cwd = process.cwd()
): boolean {
  const a = requiredRoot(left, 'left data root', platform, cwd)
  const b = requiredRoot(right, 'right data root', platform, cwd)
  return comparableRoot(a, platform) === comparableRoot(b, platform)
}

export function coherentDataRootEnvironment(
  dataRoot: string,
  platform: NodeJS.Platform | string = process.platform,
  cwd = process.cwd()
): Record<typeof PRIMARY_DATA_ROOT_ENV | typeof LEGACY_DATA_ROOT_ENV, string> {
  const resolved = requiredRoot(dataRoot, 'dataRoot', platform, cwd)
  return {
    [PRIMARY_DATA_ROOT_ENV]: resolved,
    [LEGACY_DATA_ROOT_ENV]: resolved
  }
}

function optionalRoot(
  value: string | undefined,
  label: string,
  platform: NodeJS.Platform | string,
  cwd: string
): string | undefined {
  if (value === undefined || value === '') return undefined
  return requiredRoot(value, label, platform, cwd)
}

function requiredRoot(value: string, label: string, platform: NodeJS.Platform | string, cwd: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new LocalDataRootError('INVALID_DATA_ROOT', `${label} must be a non-empty path`)
  }
  if (value.trim().length === 0 || value !== value.trim()) {
    throw new LocalDataRootError('INVALID_DATA_ROOT', `${label} must not be blank or have surrounding whitespace`)
  }
  if (/[\u0000-\u001f\u007f"]/.test(value)) {
    throw new LocalDataRootError('INVALID_DATA_ROOT', `${label} contains an unsafe path character`)
  }
  if (!hasWellFormedUnicode(value)) {
    throw new LocalDataRootError('INVALID_DATA_ROOT', `${label} contains invalid Unicode`)
  }

  const pathApi = platform === 'win32' ? path.win32 : path.posix
  if (platform === 'win32') validateWindowsRoot(value, label)
  try {
    const resolved = platform === 'win32'
      ? path.win32.normalize(value)
      : (path.posix.isAbsolute(value) ? path.posix.normalize(value) : path.posix.resolve(cwd, value))
    if (!resolved || !pathApi.isAbsolute(resolved)) {
      throw new Error('resolution did not produce an absolute path')
    }
    const rootLength = pathApi.parse(resolved).root.length
    if (resolved.length === rootLength) {
      throw new LocalDataRootError('INVALID_DATA_ROOT', `${label} must not be a filesystem root`)
    }
    return resolved.length > rootLength ? resolved.replace(/[\\/]+$/, '') : resolved
  } catch (error) {
    if (error instanceof LocalDataRootError) throw error
    throw new LocalDataRootError(
      'INVALID_DATA_ROOT',
      `${label} is not a valid path: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

function validateWindowsRoot(value: string, label: string): void {
  if (/^[\\/]{2}[?.][\\/]/.test(value) || /^[\\/]\?\?[\\/]/.test(value)) {
    throw new LocalDataRootError('INVALID_DATA_ROOT', `${label} must not use a Windows device namespace`)
  }
  const driveQualified = /^[A-Za-z]:[\\/]/.test(value)
  const unc = value.match(/^[\\/]{2}([^\\/]+)[\\/]([^\\/]+)(?:[\\/]|$)/)
  if (!driveQualified && !unc) {
    throw new LocalDataRootError(
      'INVALID_DATA_ROOT',
      `${label} must be a fully-qualified drive path or a complete UNC path`
    )
  }
  if (unc) {
    validateWindowsSegment(unc[1] as string, `${label} UNC authority`)
    validateWindowsSegment(unc[2] as string, `${label} UNC share`)
  }
  const remainder = value.slice(2)
  for (const segment of remainder.split(/[\\/]/)) {
    if (!segment || segment === '.' || segment === '..') continue
    validateWindowsSegment(segment, label)
  }
}

function validateWindowsSegment(segment: string, label: string): void {
  if (!segment || segment === '.' || segment === '..' || segment.trim() !== segment) {
    throw new LocalDataRootError('INVALID_DATA_ROOT', `${label} contains an invalid Windows path segment`)
  }
  if (/[<>|?*:]/.test(segment)) {
    throw new LocalDataRootError('INVALID_DATA_ROOT', `${label} contains an invalid Windows path character`)
  }
  if (/[. ]$/.test(segment)) {
    throw new LocalDataRootError('INVALID_DATA_ROOT', `${label} contains a Windows path segment ending in a dot or space`)
  }
  const deviceStem = segment.split('.')[0]?.toUpperCase() || ''
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(deviceStem)) {
    throw new LocalDataRootError('INVALID_DATA_ROOT', `${label} contains a reserved Windows device name`)
  }
}

function hasWellFormedUnicode(value: string): boolean {
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

function comparableRoot(value: string, platform: NodeJS.Platform | string): string {
  return platform === 'win32' ? value.toLowerCase() : value
}
