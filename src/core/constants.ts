/** @deprecated Resident Skill truth is enumerated from the user's data root. */
export const RESIDENT_SKILLS = [] as const

/** @deprecated Project-owned unity-skills remains protected, not resident. */
export const KEPT_AGENT_SKILLS = ['unity-skills'] as const

export const EXCLUDED_CHECKOUT_NAMES = ['ozdqp-skill-hub', 'ozdqp-skill-overlay-kit'] as const

export const EPHEMERAL_PATH_MARKERS = [
  '/temp/',
  '/appdata/local/temp/',
  '/.codex/worktrees/',
  '/.config/cursor/worktrees/'
] as const
