import { contextBridge, ipcRenderer } from 'electron'
import type { PEAKO_CHANNELS, PeakoCommand, PeakoLayout, PeakoState } from '../shared/peako'

// This preload runs sandboxed, where it cannot load a chunk shared with the
// main preload, so it imports types only and spells out its channels. The
// type below fails the build if one drifts from PEAKO_CHANNELS.
const CHANNELS = {
  ready: 'peako:ready',
  command: 'peako:command',
  setExpanded: 'peako:setExpanded',
  dragMove: 'peako:dragMove',
  dragEnd: 'peako:dragEnd',
  contextMenu: 'peako:contextMenu',
  state: 'peako:state',
  layout: 'peako:layout',
  startRename: 'peako:startRename'
} as const satisfies Partial<typeof PEAKO_CHANNELS>

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const handler = (_: unknown, payload: T): void => callback(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

// Peako's window gets only these calls, never the full app API.
contextBridge.exposeInMainWorld('peakoAPI', {
  ready: (): void => ipcRenderer.send(CHANNELS.ready),
  command: (command: PeakoCommand): void => ipcRenderer.send(CHANNELS.command, command),
  setExpanded: (expanded: boolean): Promise<PeakoLayout> => ipcRenderer.invoke(CHANNELS.setExpanded, expanded),
  dragMove: (x: number, y: number): void => ipcRenderer.send(CHANNELS.dragMove, x, y),
  dragEnd: (): void => ipcRenderer.send(CHANNELS.dragEnd),
  contextMenu: (): void => ipcRenderer.send(CHANNELS.contextMenu),
  onState: (callback: (state: PeakoState) => void): (() => void) => subscribe(CHANNELS.state, callback),
  onLayout: (callback: (layout: PeakoLayout) => void): (() => void) => subscribe(CHANNELS.layout, callback),
  onStartRename: (callback: () => void): (() => void) => subscribe(CHANNELS.startRename, callback)
})
