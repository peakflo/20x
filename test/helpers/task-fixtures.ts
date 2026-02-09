import type { CreateTaskData, CreateAgentData, CreateSkillData } from '../../src/main/database'

export function makeTask(overrides: Partial<CreateTaskData> = {}): CreateTaskData {
  return {
    title: 'Test Task',
    description: 'A test task description',
    type: 'general',
    priority: 'medium',
    status: 'not_started',
    assignee: '',
    due_date: null,
    labels: [],
    checklist: [],
    attachments: [],
    repos: [],
    output_fields: [],
    ...overrides
  }
}

export function makeAgent(overrides: Partial<CreateAgentData> = {}): CreateAgentData {
  return {
    name: 'Test Agent',
    server_url: 'http://localhost:4096',
    config: {},
    is_default: false,
    ...overrides
  }
}

export function makeSkill(overrides: Partial<CreateSkillData> = {}): CreateSkillData {
  return {
    name: 'Test Skill',
    description: 'A test skill description',
    content: '# Test Skill\nDo the thing.',
    ...overrides
  }
}
