export interface AvatarPreset {
  id: string
  label: string
  src: string
}

const AVATAR_PRESET_BASE_PATH = '/avatars/presets'

export const AVATAR_PRESETS: AvatarPreset[] = [
  { id: 'developer', label: 'Developer', src: `${AVATAR_PRESET_BASE_PATH}/avatar-preset-01-developer.png` },
  { id: 'architect', label: 'Architect', src: `${AVATAR_PRESET_BASE_PATH}/avatar-preset-02-architect.png` },
  { id: 'tester', label: 'Tester', src: `${AVATAR_PRESET_BASE_PATH}/avatar-preset-03-tester.png` },
  { id: 'devops', label: 'DevOps', src: `${AVATAR_PRESET_BASE_PATH}/avatar-preset-04-devops.png` },
  { id: 'data-scientist', label: 'Data scientist', src: `${AVATAR_PRESET_BASE_PATH}/avatar-preset-05-data-scientist.png` },
  { id: 'frontend', label: 'Frontend', src: `${AVATAR_PRESET_BASE_PATH}/avatar-preset-06-frontend.png` },
  { id: 'backend', label: 'Backend', src: `${AVATAR_PRESET_BASE_PATH}/avatar-preset-07-backend.png` },
  { id: 'security', label: 'Security', src: `${AVATAR_PRESET_BASE_PATH}/avatar-preset-08-security.png` },
  { id: 'project-manager', label: 'Project manager', src: `${AVATAR_PRESET_BASE_PATH}/avatar-preset-09-project-manager.png` },
  { id: 'product-manager', label: 'Product manager', src: `${AVATAR_PRESET_BASE_PATH}/avatar-preset-10-product-manager.png` },
  { id: 'scrum-master', label: 'Scrum master', src: `${AVATAR_PRESET_BASE_PATH}/avatar-preset-11-scrum-master.png` },
  { id: 'tech-lead', label: 'Tech lead', src: `${AVATAR_PRESET_BASE_PATH}/avatar-preset-12-tech-lead.png` },
  { id: 'coordinator', label: 'Coordinator', src: `${AVATAR_PRESET_BASE_PATH}/avatar-preset-13-coordinator.png` },
  { id: 'mentor', label: 'Mentor', src: `${AVATAR_PRESET_BASE_PATH}/avatar-preset-14-mentor.png` },
  { id: 'reviewer', label: 'Reviewer', src: `${AVATAR_PRESET_BASE_PATH}/avatar-preset-15-reviewer.png` },
  { id: 'ui-designer', label: 'UI designer', src: `${AVATAR_PRESET_BASE_PATH}/avatar-preset-16-ui-designer.png` },
  { id: 'ux-researcher', label: 'UX researcher', src: `${AVATAR_PRESET_BASE_PATH}/avatar-preset-17-ux-researcher.png` },
  { id: 'documenter', label: 'Documenter', src: `${AVATAR_PRESET_BASE_PATH}/avatar-preset-18-documenter.png` },
  { id: 'translator', label: 'Translator', src: `${AVATAR_PRESET_BASE_PATH}/avatar-preset-19-translator.png` },
  { id: 'analyst', label: 'Analyst', src: `${AVATAR_PRESET_BASE_PATH}/avatar-preset-20-analyst.png` },
  { id: 'consultant', label: 'Consultant', src: `${AVATAR_PRESET_BASE_PATH}/avatar-preset-21-consultant.png` },
  { id: 'creative-director', label: 'Creative director', src: `${AVATAR_PRESET_BASE_PATH}/avatar-preset-22-creative-director.png` },
  { id: 'support', label: 'Support', src: `${AVATAR_PRESET_BASE_PATH}/avatar-preset-23-support.png` },
  { id: 'assistant', label: 'Assistant', src: `${AVATAR_PRESET_BASE_PATH}/avatar-preset-24-assistant.png` },
  { id: 'robot', label: 'Robot', src: `${AVATAR_PRESET_BASE_PATH}/avatar-preset-25-robot.png` },
]
