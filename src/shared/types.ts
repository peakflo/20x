export interface SourceUser {
  id: string
  email: string
  name: string
}

export interface ReassignResult {
  success: boolean
  error?: string
}
