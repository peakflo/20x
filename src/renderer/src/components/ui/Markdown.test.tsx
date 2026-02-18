/**
 * Unit tests for Markdown component
 */

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { Markdown } from './Markdown'

describe('Markdown', () => {
  describe('Basic Rendering', () => {
    it('renders plain text', () => {
      render(<Markdown>Hello, World!</Markdown>)
      expect(screen.getByText('Hello, World!')).toBeInTheDocument()
    })

    it('applies custom className', () => {
      const { container } = render(
        <Markdown className="custom-class">Test</Markdown>
      )
      expect(container.querySelector('.custom-class')).toBeInTheDocument()
    })
  })

  describe('Headings', () => {
    it('renders h1', () => {
      render(<Markdown># Heading 1</Markdown>)
      const heading = screen.getByRole('heading', { level: 1 })
      expect(heading).toHaveTextContent('Heading 1')
    })

    it('renders h2', () => {
      render(<Markdown>## Heading 2</Markdown>)
      const heading = screen.getByRole('heading', { level: 2 })
      expect(heading).toHaveTextContent('Heading 2')
    })

    it('renders h3', () => {
      render(<Markdown>### Heading 3</Markdown>)
      const heading = screen.getByRole('heading', { level: 3 })
      expect(heading).toHaveTextContent('Heading 3')
    })
  })

  describe('Paragraphs', () => {
    it('renders paragraphs', () => {
      render(<Markdown>This is a paragraph.</Markdown>)
      expect(screen.getByText('This is a paragraph.')).toBeInTheDocument()
    })

    it('renders multiple paragraphs', () => {
      const markdown = `First paragraph.

Second paragraph.`
      render(<Markdown>{markdown}</Markdown>)
      expect(screen.getByText('First paragraph.')).toBeInTheDocument()
      expect(screen.getByText('Second paragraph.')).toBeInTheDocument()
    })
  })

  describe('Lists', () => {
    it('renders unordered lists', () => {
      const markdown = `- Item 1
- Item 2
- Item 3`
      render(<Markdown>{markdown}</Markdown>)

      const list = screen.getByRole('list')
      expect(list.tagName).toBe('UL')

      const items = screen.getAllByRole('listitem')
      expect(items).toHaveLength(3)
      expect(items[0]).toHaveTextContent('Item 1')
      expect(items[1]).toHaveTextContent('Item 2')
      expect(items[2]).toHaveTextContent('Item 3')
    })

    it('renders ordered lists', () => {
      const markdown = `1. First
2. Second
3. Third`
      const { container } = render(<Markdown>{markdown}</Markdown>)

      const list = container.querySelector('ol')
      expect(list).toBeInTheDocument()
      expect(list?.tagName).toBe('OL')

      const items = container.querySelectorAll('li')
      expect(items).toHaveLength(3)
      expect(items[0]).toHaveTextContent('First')
      expect(items[1]).toHaveTextContent('Second')
      expect(items[2]).toHaveTextContent('Third')
    })

    it('renders nested lists', () => {
      const markdown = `- Parent 1
  - Child 1
  - Child 2
- Parent 2`
      render(<Markdown>{markdown}</Markdown>)

      const lists = screen.getAllByRole('list')
      expect(lists.length).toBeGreaterThan(1)
    })
  })

  describe('Code - CRITICAL: Inline vs Block', () => {
    it('renders inline code with single backticks', () => {
      const markdown = 'This is `inline code` in text.'
      const { container } = render(<Markdown>{markdown}</Markdown>)

      const code = container.querySelector('code')
      expect(code).toBeInTheDocument()
      expect(code).toHaveTextContent('inline code')

      // CRITICAL: Inline code should NOT have 'block' class
      expect(code?.className).not.toContain('block')
      // Should have styling for inline code
      expect(code?.className).toContain('bg-muted')
      expect(code?.className).toContain('rounded')
    })

    it('renders code blocks with triple backticks', () => {
      const markdown = '```javascript\nconst x = 1;\nconst y = 2;\n```'
      const { container } = render(<Markdown>{markdown}</Markdown>)

      const pre = container.querySelector('pre')
      const code = container.querySelector('pre > code')
      expect(pre).toBeInTheDocument()
      expect(code).toBeInTheDocument()
      expect(code).toHaveTextContent('const x = 1;')

      // Code blocks should have block display class
      expect(code?.className).toContain('block')
    })

    it('inline code stays inline in lists', () => {
      const markdown = '- Item with `inline code` here'
      const { container } = render(<Markdown>{markdown}</Markdown>)

      const code = container.querySelector('code')
      expect(code).toBeInTheDocument()

      // CRITICAL: Must NOT have block class even inside list
      expect(code?.className).not.toContain('block')
    })

    it('renders multiple inline code elements', () => {
      const markdown = 'Use `foo` and `bar` together.'
      const { container } = render(<Markdown>{markdown}</Markdown>)

      const codeElements = container.querySelectorAll('code')
      expect(codeElements).toHaveLength(2)
      expect(codeElements[0]).toHaveTextContent('foo')
      expect(codeElements[1]).toHaveTextContent('bar')

      // Both should be inline (not block)
      codeElements.forEach(code => {
        expect(code.className).not.toContain('block')
      })
    })
  })

  describe('Links', () => {
    it('renders links', () => {
      const markdown = '[Click here](https://example.com)'
      render(<Markdown>{markdown}</Markdown>)

      const link = screen.getByRole('link', { name: 'Click here' })
      expect(link).toHaveAttribute('href', 'https://example.com')
      expect(link).toHaveAttribute('target', '_blank')
      expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    })

    it('renders multiple links', () => {
      const markdown = '[Link 1](https://example.com) and [Link 2](https://test.com)'
      const { container } = render(<Markdown>{markdown}</Markdown>)

      const links = container.querySelectorAll('a')
      expect(links).toHaveLength(2)
      expect(links[0]).toHaveTextContent('Link 1')
      expect(links[1]).toHaveTextContent('Link 2')
    })
  })

  describe('Blockquotes', () => {
    it('renders blockquotes', () => {
      const markdown = '> This is a quote'
      const { container } = render(<Markdown>{markdown}</Markdown>)

      const blockquote = container.querySelector('blockquote')
      expect(blockquote).toBeInTheDocument()
      expect(blockquote).toHaveTextContent('This is a quote')
    })
  })

  describe('Horizontal Rules', () => {
    it('renders horizontal rules', () => {
      const markdown = 'Before\n\n---\n\nAfter'
      const { container } = render(<Markdown>{markdown}</Markdown>)

      const hr = container.querySelector('hr')
      expect(hr).toBeInTheDocument()
    })
  })

  describe('Tables (GitHub-flavored markdown)', () => {
    it('renders tables with headers and rows', () => {
      const markdown = `| Header 1 | Header 2 |
|----------|----------|
| Cell 1   | Cell 2   |
| Cell 3   | Cell 4   |`

      render(<Markdown>{markdown}</Markdown>)

      const table = screen.getByRole('table')
      expect(table).toBeInTheDocument()

      // Check headers
      const headers = screen.getAllByRole('columnheader')
      expect(headers).toHaveLength(2)
      expect(headers[0]).toHaveTextContent('Header 1')
      expect(headers[1]).toHaveTextContent('Header 2')

      // Check cells
      const cells = screen.getAllByRole('cell')
      expect(cells).toHaveLength(4)
      expect(cells[0]).toHaveTextContent('Cell 1')
      expect(cells[1]).toHaveTextContent('Cell 2')
      expect(cells[2]).toHaveTextContent('Cell 3')
      expect(cells[3]).toHaveTextContent('Cell 4')
    })

    it('renders status mapping table correctly', () => {
      const markdown = `| HubSpot Stage | Task Status |
|---------------|-------------|
| New / Waiting | Not Started |
| In Progress / Working | In Progress |
| Closed / Resolved | Completed |`

      render(<Markdown>{markdown}</Markdown>)

      expect(screen.getByText('HubSpot Stage')).toBeInTheDocument()
      expect(screen.getByText('Task Status')).toBeInTheDocument()
      expect(screen.getByText('New / Waiting')).toBeInTheDocument()
      expect(screen.getByText('Not Started')).toBeInTheDocument()
      expect(screen.getByText('In Progress / Working')).toBeInTheDocument()
      expect(screen.getByText('In Progress')).toBeInTheDocument()
      expect(screen.getByText('Closed / Resolved')).toBeInTheDocument()
      expect(screen.getByText('Completed')).toBeInTheDocument()
    })

    it('wraps table in overflow container', () => {
      const markdown = `| A | B |
|---|---|
| 1 | 2 |`

      const { container } = render(<Markdown>{markdown}</Markdown>)

      const wrapper = container.querySelector('.overflow-x-auto')
      expect(wrapper).toBeInTheDocument()

      const table = wrapper?.querySelector('table')
      expect(table).toBeInTheDocument()
    })
  })

  describe('Size Variants', () => {
    it('renders with xs size', () => {
      const { container } = render(
        <Markdown size="xs">Test content</Markdown>
      )
      expect(container.querySelector('.text-xs')).toBeInTheDocument()
    })

    it('renders with sm size', () => {
      const { container } = render(
        <Markdown size="sm">Test content</Markdown>
      )
      expect(container.querySelector('.text-sm')).toBeInTheDocument()
    })

    it('renders with base size', () => {
      const { container } = render(
        <Markdown size="base">Test content</Markdown>
      )
      expect(container.querySelector('.text-base')).toBeInTheDocument()
    })

    it('defaults to sm size when not specified', () => {
      const { container } = render(<Markdown>Test content</Markdown>)
      expect(container.querySelector('.text-sm')).toBeInTheDocument()
    })
  })

  describe('Complex Markdown', () => {
    it('renders mixed content correctly', () => {
      const markdown = `# Main Title

This is a paragraph with **bold** and *italic* text.

## Section

- List item with \`code\`
- Another item

[Link](https://example.com)

> A quote

| Col 1 | Col 2 |
|-------|-------|
| A     | B     |`

      const { container } = render(<Markdown>{markdown}</Markdown>)

      const h1 = container.querySelector('h1')
      const h2 = container.querySelector('h2')
      const link = container.querySelector('a')
      const table = container.querySelector('table')
      const blockquote = container.querySelector('blockquote')
      const code = container.querySelector('code')

      expect(h1).toHaveTextContent('Main Title')
      expect(h2).toHaveTextContent('Section')
      expect(link).toBeInTheDocument()
      expect(table).toBeInTheDocument()
      expect(blockquote).toBeInTheDocument()
      expect(code).toBeInTheDocument()
    })

    it('handles markdown in documentation format', () => {
      const markdown = `## Prerequisites

- A HubSpot account with CRM access
- Admin permissions to create apps

### Step 1: Setup

1. Go to the **Auth** tab
2. Add **Redirect URLs:**
   - \`http://localhost:3000/callback\`
   - \`http://localhost:3001/callback\`
3. Select **Required Scopes:**
   - \`tickets\`
   - \`files\``

      render(<Markdown>{markdown}</Markdown>)

      expect(screen.getByText('Prerequisites')).toBeInTheDocument()
      expect(screen.getByText('Step 1: Setup')).toBeInTheDocument()
      expect(screen.getByText(/A HubSpot account/)).toBeInTheDocument()

      const codeElements = screen.getAllByText('tickets')
      expect(codeElements.length).toBeGreaterThan(0)
    })
  })

  describe('Edge Cases', () => {
    it('handles empty string', () => {
      const { container } = render(<Markdown>{''}</Markdown>)
      expect(container.querySelector('.markdown-content')).toBeInTheDocument()
    })

    it('handles string with only whitespace', () => {
      render(<Markdown>   </Markdown>)
      // Should render without errors
    })

    it('handles special characters', () => {
      const markdown = 'Text with <special> & "characters"'
      render(<Markdown>{markdown}</Markdown>)
      expect(screen.getByText(/Text with/)).toBeInTheDocument()
    })

    it('handles very long inline code', () => {
      const longCode = 'a'.repeat(100)
      const markdown = `Text with \`${longCode}\` code`
      const { container } = render(<Markdown>{markdown}</Markdown>)

      const code = container.querySelector('code')
      expect(code).toBeInTheDocument()
      expect(code?.textContent?.length).toBeGreaterThan(90)
    })
  })
})
