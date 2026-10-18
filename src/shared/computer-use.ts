export interface ComputerWindow {
  pid: number
  window_id: number
  app_name: string
  title: string
  is_on_screen?: boolean
}

export interface ComputerGrant {
  taskId: string
  window: ComputerWindow
  grantedAt: number
}

export interface ComputerStatus {
  grant: ComputerGrant | null
}
