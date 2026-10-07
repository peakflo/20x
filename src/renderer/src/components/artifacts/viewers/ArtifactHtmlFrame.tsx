import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ArtifactContent } from '@shared/artifacts'
import { ARTIFACT_BRIDGE_HANDSHAKE, ARTIFACT_MCP_SHIM } from '@shared/artifact-mcp'
import {
  applyHtmlRenderShell,
  clampHtmlRenderHeight,
  HTML_RENDER_SIZE_MESSAGE_TYPE,
  HTML_RENDER_THEME_MESSAGE_TYPE,
  isHtmlRenderSizeMessage,
  type HtmlRenderTheme
} from '@shared/html-render'
import { prepareArtifactHtml } from '../artifact-resources'
import { useHtmlRenderTheme } from './useHtmlRenderTheme'

/** Posts the frame's content height to the host, clamped on the host side
 * (never trust the frame's own arithmetic). Runs on load, on font-ready +
 * two animation frames, and on every ResizeObserver tick of `<html>`. */
const SIZE_BOOTSTRAP_SCRIPT = `<script>(function(){
  var last=-1;
  function send(){
    var r=document.documentElement;
    var h=Math.round(r.scrollHeight>r.clientHeight?r.scrollHeight:r.getBoundingClientRect().height);
    if(h===last)return;
    last=h;
    window.parent.postMessage({type:'${HTML_RENDER_SIZE_MESSAGE_TYPE}',height:h},'*');
  }
  if(window.ResizeObserver)new ResizeObserver(send).observe(document.documentElement);
  document.addEventListener('DOMContentLoaded',send);
  window.addEventListener('load',send);
  if(document.fonts&&document.fonts.ready){document.fonts.ready.then(function(){requestAnimationFrame(function(){requestAnimationFrame(send)})})}else{requestAnimationFrame(function(){requestAnimationFrame(send)})}
})();</script>`

/** Applies a theme pushed by the host after the document has loaded, without
 * a reload — only the `--variable` values and the dark class change. */
const THEME_LISTENER_SCRIPT = `<script>window.addEventListener('message',function(event){
  var data=event.data;
  if(!data||data.type!=='${HTML_RENDER_THEME_MESSAGE_TYPE}'||!data.theme)return;
  var style=document.getElementById('20x-theme');
  if(!style)return;
  var vars=data.theme,out='';
  for(var k in vars){if(k==='appearance')continue;out+='--'+k+':'+vars[k]+';'}
  if(vars.appearance)out+='color-scheme:'+vars.appearance+';';
  style.textContent=':root{'+out+'}';
  document.documentElement.classList.toggle('dark',vars.appearance==='dark');
});</script>`

function interactiveScripts(): string {
  return `<script>window.open=function(){return null};document.addEventListener('click',function(event){var a=event.target.closest&&event.target.closest('a[href]');if(!a)return;var href=a.getAttribute('href');if(!href||href.charAt(0)==='#')return;event.preventDefault();window.parent.postMessage({type:'artifact:open-file',href:href},'*')},true);</script>${SIZE_BOOTSTRAP_SCRIPT}${THEME_LISTENER_SCRIPT}${ARTIFACT_MCP_SHIM}`
}

const EMPTY_DOCUMENT = '<!doctype html><html><head></head><body></body></html>'

/**
 * Put the guard BEFORE any artifact text. Never search the source for
 * `<head>`: the first TEXTUAL match can be inside a comment or an attribute
 * value (`<html data-x="<head>">`), and then the CSP meta is not an element
 * and the frame has no CSP. A `<meta>` right after the doctype opens the
 * implied head, so the guard is the head's first child; a later `<html>` tag
 * only adds its attributes and a later `<head>` is ignored.
 *
 * `theme`, when given, is baked in as the initial `#20x-theme` style so the
 * very first paint is already themed (no flash of the wrong palette). Later
 * theme changes are pushed over `postMessage` by the caller instead of
 * calling this again — changing srcDoc would reload the document.
 */
export function hardenArtifactHtml(source: string, theme?: HtmlRenderTheme): string {
  const shelled = applyHtmlRenderShell(source, theme)
  // Insert the interactive scripts right after the shell `applyHtmlRenderShell`
  // just added (CSP meta + base + theme style), still before any artifact
  // content/markup.
  const shellEnd = shelled.indexOf('</style>') + '</style>'.length
  return `${shelled.slice(0, shellEnd)}${interactiveScripts()}${shelled.slice(shellEnd)}`
}

type Reply = (message: Record<string, unknown>) => void

/**
 * Keep file navigation in the host. The frame cannot read local files or
 * navigate the app, and messages from other frames are ignored.
 *
 * TOOL CALLS USE A MessagePort, NEVER `postMessage(reply, '*')`. The sandbox
 * cannot stop a frame from navigating itself. The new page keeps origin
 * `'null'` and the same `contentWindow`, so origin and source checks cannot
 * tell it from the artifact, and it does not have the artifact CSP. The shim
 * is the first script in the document and sends one port with a handshake.
 * The FIRST handshake per iframe element is accepted; later ones are ignored.
 * A port dies with its document, so a page that replaces the artifact can
 * neither call tools nor receive replies. The iframe is keyed by its
 * document, so new content gets a new element and a new handshake.
 */
export function ArtifactHtmlFrame({
  html, title, taskId, path, files, readFile, onLinkClick, onMessage,
  fill = true, height, onContentHeight
}: {
  html: string
  title: string
  taskId: string
  path: string
  files: string[]
  readFile: (taskId: string, path: string) => Promise<ArtifactContent | null>
  onLinkClick?: (href: string) => boolean
  onMessage?: (data: unknown, reply: Reply) => void
  /** Default true: fills its container (the artifact panel/tab). Set false
   * for an inline render that auto-sizes to `height` instead. */
  fill?: boolean
  /** Pixel height to use when `fill` is false. */
  height?: number
  /** Called with the frame's own measured content height (clamped 80..2000)
   * as it changes — only fires when `fill` is false. */
  onContentHeight?: (height: number) => void
}) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [prepared, setPrepared] = useState<string | null>(null)
  const filesKey = files.join('\0')
  useEffect(() => {
    let cancelled = false
    setPrepared(null)
    void prepareArtifactHtml(html, path, files, (file) => readFile(taskId, file)).then((result) => {
      if (!cancelled) setPrepared(result)
    }).catch(() => {
      if (!cancelled) setPrepared('<!doctype html><html><head></head><body>Artifact preview is not available.</body></html>')
    })
    return () => { cancelled = true }
  }, [html, path, filesKey, readFile, taskId])

  // The live theme (follows the app's own light/dark toggle). Baked into the
  // document on (re)mount; later changes are pushed over postMessage below,
  // never by recomputing srcDoc — that would reload the page.
  const theme = useHtmlRenderTheme()
  const themeRef = useRef(theme)
  themeRef.current = theme
  const bakedThemeRef = useRef<HtmlRenderTheme | undefined>(undefined)
  const srcDoc = useMemo(() => {
    bakedThemeRef.current = themeRef.current
    return hardenArtifactHtml(prepared || EMPTY_DOCUMENT, themeRef.current)
  }, [prepared])

  useEffect(() => {
    if (bakedThemeRef.current === theme) return
    bakedThemeRef.current = theme
    frameRef.current?.contentWindow?.postMessage({ type: HTML_RENDER_THEME_MESSAGE_TYPE, theme }, '*')
  }, [theme])

  // Callers pass inline arrows. Keep the latest ones without re-running the
  // effect, because a re-run would forget the accepted port.
  const onLinkClickRef = useRef(onLinkClick)
  const onMessageRef = useRef(onMessage)
  const onContentHeightRef = useRef(onContentHeight)
  onLinkClickRef.current = onLinkClick
  onMessageRef.current = onMessage
  onContentHeightRef.current = onContentHeight
  useLayoutEffect(() => {
    let port: MessagePort | null = null
    const listener = (event: MessageEvent) => {
      if (event.origin !== 'null' || !frameRef.current?.contentWindow || event.source !== frameRef.current.contentWindow) return
      if (event.data?.type === 'artifact:open-file' && typeof event.data.href === 'string') {
        onLinkClickRef.current?.(event.data.href)
        return
      }
      if (isHtmlRenderSizeMessage(event.data)) {
        onContentHeightRef.current?.(clampHtmlRenderHeight(event.data.height))
        return
      }
      if (port || event.data?.type !== ARTIFACT_BRIDGE_HANDSHAKE || event.ports?.length !== 1) return
      const accepted = event.ports[0]
      port = accepted
      accepted.onmessage = (portEvent: MessageEvent) => {
        onMessageRef.current?.(portEvent.data, (message) => accepted.postMessage(message))
      }
    }
    window.addEventListener('message', listener)
    return () => {
      window.removeEventListener('message', listener)
      port?.close()
    }
  }, [srcDoc])
  return (
    <iframe
      key={srcDoc}
      ref={frameRef}
      title={title}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      srcDoc={srcDoc}
      className={fill ? 'h-full w-full border-0 bg-white' : 'w-full border-0'}
      style={fill ? undefined : { height: `${height ?? 80}px` }}
    />
  )
}
