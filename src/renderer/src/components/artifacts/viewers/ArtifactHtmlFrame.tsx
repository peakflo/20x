import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ArtifactContent } from '@shared/artifacts'
import { prepareArtifactHtml } from '../artifact-resources'

const HARDENING = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; media-src data: blob:; style-src 'unsafe-inline' data:; script-src 'unsafe-inline' data:; font-src data:"><base href="about:blank"><script>window.open=function(){return null};document.addEventListener('click',function(event){var a=event.target.closest&&event.target.closest('a[href]');if(!a)return;var href=a.getAttribute('href');if(!href||href.charAt(0)==='#')return;event.preventDefault();window.parent.postMessage({type:'artifact:open-file',href:href},'*')},true);</script>`

/** Keep file navigation in the host. The frame cannot read local files or
 * navigate the app, and messages from other frames are ignored. */
export function ArtifactHtmlFrame({ html, title, taskId, path, files, readFile, onLinkClick, onMessage }: { html: string; title: string; taskId: string; path: string; files: string[]; readFile: (taskId: string, path: string) => Promise<ArtifactContent | null>; onLinkClick?: (href: string) => boolean; onMessage?: (data: unknown) => void }) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [prepared, setPrepared] = useState<string | null>(null)
  const filesKey = files.join('\0')
  useEffect(() => {
    let cancelled = false
    setPrepared(null)
    void prepareArtifactHtml(html, path, files, (file) => readFile(taskId, file)).then((result) => {
      if (!cancelled) setPrepared(result)
    }).catch(() => {
      if (!cancelled) setPrepared(html)
    })
    return () => { cancelled = true }
  }, [html, path, filesKey, readFile, taskId])
  const srcDoc = useMemo(() => `${HARDENING}${prepared || ''}`, [prepared])
  useLayoutEffect(() => {
    const listener = (event: MessageEvent) => {
      if (event.origin !== 'null' || !frameRef.current?.contentWindow || event.source !== frameRef.current.contentWindow) return
      if (event.data?.type === 'artifact:open-file' && typeof event.data.href === 'string') {
        onLinkClick?.(event.data.href)
      } else onMessage?.(event.data)
    }
    window.addEventListener('message', listener)
    return () => window.removeEventListener('message', listener)
  }, [onLinkClick, onMessage])
  return <iframe ref={frameRef} title={title} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={srcDoc} className="h-full w-full border-0 bg-white" />
}
