/**
 * Plugin Setup Documentation Component
 *
 * Renders markdown documentation for plugin setup instructions.
 * Used in the Task Source configuration modal to provide step-by-step guides.
 */

import ReactMarkdown from 'react-markdown'
import { cn } from '@/lib/utils'

interface PluginSetupDocumentationProps {
  markdown: string
  className?: string
}

export function PluginSetupDocumentation({ markdown, className }: PluginSetupDocumentationProps) {
  return (
    <div className={cn('prose prose-sm max-w-none dark:prose-invert', className)}>
      <ReactMarkdown
        components={{
          // Customize heading styles
          h1: ({ children, ...props }) => (
            <h1 className="text-xl font-bold text-foreground mb-4 mt-6 first:mt-0" {...props}>
              {children}
            </h1>
          ),
          h2: ({ children, ...props }) => (
            <h2 className="text-lg font-semibold text-foreground mb-3 mt-5 first:mt-0" {...props}>
              {children}
            </h2>
          ),
          h3: ({ children, ...props }) => (
            <h3 className="text-base font-semibold text-foreground mb-2 mt-4" {...props}>
              {children}
            </h3>
          ),
          // Customize paragraph styles
          p: ({ children, ...props }) => (
            <p className="text-sm text-foreground/90 mb-3 leading-relaxed" {...props}>
              {children}
            </p>
          ),
          // Customize list styles
          ul: ({ children, ...props }) => (
            <ul className="list-disc list-inside text-sm text-foreground/90 mb-3 space-y-1" {...props}>
              {children}
            </ul>
          ),
          ol: ({ children, ...props }) => (
            <ol className="list-decimal list-inside text-sm text-foreground/90 mb-3 space-y-1" {...props}>
              {children}
            </ol>
          ),
          li: ({ children, ...props }) => (
            <li className="text-sm text-foreground/90" {...props}>
              {children}
            </li>
          ),
          // Customize code styles
          code: ({ inline, children, ...props }: any) =>
            inline ? (
              <code
                className="bg-muted px-1.5 py-0.5 rounded text-xs font-mono text-foreground"
                {...props}
              >
                {children}
              </code>
            ) : (
              <code
                className="block bg-muted p-3 rounded-md text-xs font-mono text-foreground overflow-x-auto mb-3"
                {...props}
              >
                {children}
              </code>
            ),
          // Customize link styles
          a: ({ children, ...props }) => (
            <a
              className="text-primary hover:underline cursor-pointer"
              target="_blank"
              rel="noopener noreferrer"
              {...props}
            >
              {children}
            </a>
          ),
          // Customize blockquote styles
          blockquote: ({ children, ...props }) => (
            <blockquote
              className="border-l-4 border-primary/30 pl-4 italic text-foreground/80 mb-3"
              {...props}
            >
              {children}
            </blockquote>
          ),
          // Customize table styles
          table: ({ children, ...props }) => (
            <div className="overflow-x-auto mb-3">
              <table className="min-w-full border-collapse border border-border" {...props}>
                {children}
              </table>
            </div>
          ),
          thead: ({ children, ...props }) => (
            <thead className="bg-muted" {...props}>
              {children}
            </thead>
          ),
          th: ({ children, ...props }) => (
            <th className="border border-border px-3 py-2 text-left text-sm font-semibold text-foreground" {...props}>
              {children}
            </th>
          ),
          td: ({ children, ...props }) => (
            <td className="border border-border px-3 py-2 text-sm text-foreground/90" {...props}>
              {children}
            </td>
          ),
          // Customize horizontal rule
          hr: ({ ...props }) => <hr className="border-border my-6" {...props} />
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  )
}
