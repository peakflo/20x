import { create } from 'zustand'
import { connectWebSocket, setStatusChangeHandler, setReconnectHandler, setFirstConnectHandler, setVisibilityReconnectHandler } from '../api/websocket'

type Callback = () => void

interface ConnectionState {
  connected: boolean
  connect: () => void
  setOnReconnect: (fn: Callback) => void
  setOnFirstConnect: (fn: Callback) => void
  setOnVisibilityReconnect: (fn: Callback) => void
}

export const useConnectionStore = create<ConnectionState>((set) => {
  setStatusChangeHandler((connected) => set({ connected }))

  return {
    connected: false,
    connect: () => {
      connectWebSocket()
    },
    setOnReconnect: (fn: Callback) => {
      setReconnectHandler(fn)
    },
    setOnFirstConnect: (fn: Callback) => {
      setFirstConnectHandler(fn)
    },
    setOnVisibilityReconnect: (fn: Callback) => {
      setVisibilityReconnectHandler(fn)
    }
  }
})
