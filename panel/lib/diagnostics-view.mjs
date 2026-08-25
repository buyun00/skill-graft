function record(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

export function mapDoctorDiagnostics(value) {
  const report = record(value)
  const daemon = record(report.daemon)
  const lifecycle = record(report.lifecycle)
  const reviewLocks = record(lifecycle.reviewLocks)
  const apiUrl = typeof daemon.apiUrl === 'string' ? daemon.apiUrl : ''
  let apiPort = ''
  try {
    apiPort = apiUrl ? new URL(apiUrl).port : ''
  } catch {
    apiPort = ''
  }
  return {
    ok: report.ok === true,
    apiUrl,
    apiPort,
    lifecycle: {
      manifest: lifecycle.manifest,
      ownership: lifecycle.ownership,
      lockHealthy: lifecycle.lockHealthy,
      dataMarker: lifecycle.dataMarker,
      packageVersion: lifecycle.packageVersion,
      installedVersion: lifecycle.installedVersion,
      versionMatch: lifecycle.versionMatch,
      corpusEmpty: lifecycle.corpusEmpty,
      lockState: lifecycle.lockState,
      walPending: lifecycle.walPending,
      durablePending: lifecycle.durablePending,
      reviewLocks: {
        active: reviewLocks.active,
        stale: reviewLocks.stale,
        unverifiable: reviewLocks.unverifiable
      }
    }
  }
}
