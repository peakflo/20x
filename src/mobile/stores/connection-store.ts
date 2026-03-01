import { create } from 'zustand'
import { connectWebSocket, setStatusChangeHandler } from '../api/websocket'

interface ConnectionState {
  connected: boolean
  connect: () => void
}

export const useConnectionStore = create<ConnectionState>((set) => {
  setStatusChangeHandler((connected) => set({ connected }))

  return {
    connected: false,
    connect: () => {
      connectWebSocket()
    }
  }
})
