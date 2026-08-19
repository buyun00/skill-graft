export const RESIDENT_SKILLS = [
  'ozdqp-development',
  'ozdqp-ui-development',
  'ozdqp-git-workflow'
] as const

export const KEPT_AGENT_SKILLS = [...RESIDENT_SKILLS, 'unity-skills'] as const

export const EXCLUDED_CHECKOUT_NAMES = ['ozdqp-skill-hub', 'ozdqp-skill-overlay-kit'] as const

export const EPHEMERAL_PATH_MARKERS = [
  '/temp/',
  '/appdata/local/temp/',
  '/.codex/worktrees/',
  '/.config/cursor/worktrees/'
] as const
