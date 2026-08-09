import { useEffect, type RefObject } from 'react'
import { voiceApi } from '@/lib/ipc-client'

/**
 * Writes dictated words into a text control (design §5.1).
 *
 * The transcript panel keeps its composer uncontrolled, so the text is written
 * straight into the DOM value and the caller re-measures the height. Only the
 * mounted composer subscribes, so words never land in a hidden field.
 */
export function useVoiceDictation(
  inputRef: RefObject<HTMLTextAreaElement | null>,
  afterInsert?: () => void
): void {
  useEffect(() => {
    if (typeof window === 'undefined' || !window.electronAPI?.voice) return undefined
    return voiceApi.onDictate(({ text }) => {
      const element = inputRef.current
      if (!element || !text.trim()) return
      // Only write into the composer the user is actually looking at.
      if (!element.isConnected) return
      const separator = element.value && !/\s$/.test(element.value) ? ' ' : ''
      element.value = `${element.value}${separator}${text.trim()}`
      element.focus()
      element.setSelectionRange(element.value.length, element.value.length)
      afterInsert?.()
    })
  }, [inputRef, afterInsert])
}
