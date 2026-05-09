/**
 * Standardized Markdown Renderer
 *
 * Provides consistent markdown rendering across the application with proper styling.
 * Used in: task descriptions, agent transcripts, plugin documentation.
 */

import { memo, useMemo } from 'react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '@/lib/utils'

/** Allow the default safe protocols plus our local app-attachment:// scheme */
function urlTransform(url: string): string {
  if (url.startsWith('app-attachment://')) return url
  return defaultUrlTransform(url)
}

type MarkdownSize = 'xs' | 'sm' | 'base'

interface MarkdownProps {
  children: string
  size?: MarkdownSize
  className?: string
}

// Hoisted to module scope to prevent recreation on every render
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const REMARK_PLUGINS = [remarkGfm] as any[]

// Size-based class mappings — hoisted to module scope (static data)
const SIZE_CLASSES = {
  xs: {
    base: 'text-xs',
    h1: 'text-sm font-semibold mt-3 mb-1.5',
    h2: 'text-xs font-semibold mt-2.5 mb-1.5',
    h3: 'text-xs font-semibold mt-2 mb-1',
    p: 'my-1.5',
    list: 'pl-3.5 my-1.5 space-y-0.5',
    li: 'ml-0.5',
    code: 'px-1 py-0.5 text-[11px]',
    codeBlock: 'p-2 my-1.5 text-[11px]',
    blockquote: 'pl-2.5 my-1.5',
    hr: 'my-2',
    table: 'my-1.5',
    th: 'px-2 py-1 text-[11px]',
    td: 'px-2 py-1 text-[11px]'
  },
  sm: {
    base: 'text-sm',
    h1: 'text-base font-semibold mt-4 mb-2',
    h2: 'text-sm font-semibold mt-3 mb-2',
    h3: 'text-sm font-semibold mt-2 mb-1',
    p: 'my-2',
    list: 'pl-4 my-2 space-y-1',
    li: 'ml-1',
    code: 'px-1.5 py-0.5 text-xs',
    codeBlock: 'p-3 my-2',
    blockquote: 'pl-3 my-2',
    hr: 'my-3',
    table: 'my-2',
    th: 'px-2.5 py-1.5 text-xs',
    td: 'px-2.5 py-1.5 text-xs'
  },
  base: {
    base: 'text-base',
    h1: 'text-xl font-bold mt-6 mb-4 first:mt-0',
    h2: 'text-lg font-semibold mt-5 mb-3 first:mt-0',
    h3: 'text-base font-semibold mt-4 mb-2',
    p: 'mb-3 leading-relaxed',
    list: 'ml-5 mb-3 space-y-1.5',
    li: 'leading-relaxed',
    code: 'px-1.5 py-0.5 text-xs',
    codeBlock: 'p-3 mb-3 mt-2',
    blockquote: 'pl-4 mb-3',
    hr: 'my-6',
    table: 'mb-3',
    th: 'px-3 py-2 text-sm',
    td: 'px-3 py-2 text-sm'
  }
}

/**
 * Reusable markdown component with standardized styling.
 * - Single backticks (`) render as inline code
 * - Triple backticks (```) render as code blocks
 * - Proper list formatting with indentation
 * - Consistent heading hierarchy
 *
 * Wrapped with React.memo to prevent re-renders when used inside virtualized lists
 * (e.g., the agent transcript) where parent scrolling would otherwise trigger
 * recreation of the components config object on every frame.
 */
export const Markdown = memo(function Markdown({ children, size = 'sm', className }: MarkdownProps) {
  const classes = SIZE_CLASSES[size]

  // Memoize the components config object per `size` to avoid creating a new
  // object reference on every render — ReactMarkdown does a shallow comparison.
  const components = useMemo(() => ({
    // Headings
    h1: ({ children, ...props }: React.ComponentPropsWithoutRef<'h1'>) => (
      <h1 className={cn(classes.h1, 'text-foreground')} {...props}>{children}</h1>
    ),
    h2: ({ children, ...props }: React.ComponentPropsWithoutRef<'h2'>) => (
      <h2 className={cn(classes.h2, 'text-foreground')} {...props}>{children}</h2>
    ),
    h3: ({ children, ...props }: React.ComponentPropsWithoutRef<'h3'>) => (
      <h3 className={cn(classes.h3, 'text-foreground')} {...props}>{children}</h3>
    ),
    // Paragraphs
    p: ({ children, ...props }: React.ComponentPropsWithoutRef<'p'>) => (
      <p className={cn(classes.p, 'text-foreground/90')} {...props}>{children}</p>
    ),
    // Lists
    ul: ({ children, ...props }: React.ComponentPropsWithoutRef<'ul'>) => (
      <ul className={cn('list-disc list-outside', classes.list, 'text-foreground/90')} {...props}>{children}</ul>
    ),
    ol: ({ children, ...props }: React.ComponentPropsWithoutRef<'ol'>) => (
      <ol className={cn('list-decimal list-outside', classes.list, 'text-foreground/90')} {...props}>{children}</ol>
    ),
    li: ({ children, ...props }: React.ComponentPropsWithoutRef<'li'>) => (
      <li className={cn(classes.li, 'text-foreground/90')} {...props}>{children}</li>
    ),
    // Code - CRITICAL: inline code must always be inline, block code must be block
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    code: ({ inline, children, className: codeClassName, ...props }: any) => {
      const isCodeBlock = codeClassName?.startsWith('language-')
      if (isCodeBlock || inline === false) {
        return (
          <code className={cn('block font-mono text-foreground whitespace-pre', codeClassName)} {...props}>
            {children}
          </code>
        )
      }
      return (
        <code
          className={cn('bg-muted rounded font-mono text-foreground break-all', classes.code)}
          style={{ display: 'inline !important' } as React.CSSProperties}
          {...props}
        >
          {children}
        </code>
      )
    },
    // Pre (wraps code blocks) — sole scroll container for fenced code
    pre: ({ children, ...props }: React.ComponentPropsWithoutRef<'pre'>) => (
      <pre className={cn('bg-muted rounded overflow-x-auto w-full', classes.codeBlock)} {...props}>{children}</pre>
    ),
    // Links
    a: ({ children, ...props }: React.ComponentPropsWithoutRef<'a'>) => (
      <a className="text-primary hover:underline cursor-pointer" target="_blank" rel="noopener noreferrer" {...props}>{children}</a>
    ),
    // Images
    img: ({ alt, src, ...props }: React.ComponentPropsWithoutRef<'img'>) => (
      <img alt={alt || ''} src={src} className="max-w-full h-auto rounded my-2" loading="lazy" {...props} />
    ),
    // Blockquotes
    blockquote: ({ children, ...props }: React.ComponentPropsWithoutRef<'blockquote'>) => (
      <blockquote className={cn('border-l-2 border-border italic text-foreground/80', classes.blockquote)} {...props}>{children}</blockquote>
    ),
    // Horizontal rules
    hr: ({ ...props }: React.ComponentPropsWithoutRef<'hr'>) => <hr className={cn('border-border', classes.hr)} {...props} />,
    // Tables
    table: ({ children, ...props }: React.ComponentPropsWithoutRef<'table'>) => (
      <div className={cn('overflow-x-auto', classes.table)}>
        <table className="min-w-full border-collapse border border-border" {...props}>{children}</table>
      </div>
    ),
    thead: ({ children, ...props }: React.ComponentPropsWithoutRef<'thead'>) => (
      <thead className="bg-muted" {...props}>{children}</thead>
    ),
    th: ({ children, ...props }: React.ComponentPropsWithoutRef<'th'>) => (
      <th className={cn('border border-border text-left font-semibold text-foreground', classes.th)} {...props}>{children}</th>
    ),
    td: ({ children, ...props }: React.ComponentPropsWithoutRef<'td'>) => (
      <td className={cn('border border-border text-foreground/90', classes.td)} {...props}>{children}</td>
    ),
    tbody: ({ children, ...props }: React.ComponentPropsWithoutRef<'tbody'>) => (
      <tbody {...props}>{children}</tbody>
    ),
    tr: ({ children, ...props }: React.ComponentPropsWithoutRef<'tr'>) => (
      <tr className="hover:bg-muted/50 transition-colors" {...props}>{children}</tr>
    ),
  }), [size]) // Only recreate when size changes

  return (
    <div className={cn('markdown-content min-w-0', classes.base, className)}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        urlTransform={urlTransform}
        components={components}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
})
