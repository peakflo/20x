import { describe, it, expect } from 'vitest'
import {
  extractJsonBlock,
  extractPartialJson,
  extractOutputFromMessages,
  collectWrittenFiles
} from './output-extraction'

describe('extractJsonBlock', () => {
  it('extracts json code block', () => {
    const text = 'Some text\n```json\n{"key": "value"}\n```\nMore text'
    expect(extractJsonBlock(text)).toEqual({ key: 'value' })
  })

  it('extracts last json block when multiple exist', () => {
    const text = '```json\n{"first": true}\n```\nSome text\n```json\n{"last": true}\n```'
    expect(extractJsonBlock(text)).toEqual({ last: true })
  })

  it('extracts plain code block as fallback', () => {
    const text = 'Some text\n```\n{"key": "value"}\n```'
    expect(extractJsonBlock(text)).toEqual({ key: 'value' })
  })

  it('prefers json block over plain block', () => {
    const text = '```\n{"plain": true}\n```\n```json\n{"typed": true}\n```'
    expect(extractJsonBlock(text)).toEqual({ typed: true })
  })

  it('returns null when no code block', () => {
    expect(extractJsonBlock('no code block here')).toBeNull()
  })

  it('handles truncated JSON via partial extraction', () => {
    const text = '```json\n{"key": "value", "other": "trun\n```'
    const result = extractJsonBlock(text)
    expect(result).toEqual({ key: 'value' })
  })

  it('skips non-json code blocks (python etc)', () => {
    const text = '```python\nprint("hello")\n```\n```json\n{"result": 42}\n```'
    expect(extractJsonBlock(text)).toEqual({ result: 42 })
  })

  it('handles real agent output with task completion summary', () => {
    const text = `## Task Completion Summary

I have successfully completed the GL Account Mapping Algorithm task with all requirements fulfilled. Here are the key accomplishments:

**All Tasks Completed:**

1. **Data Analysis**: Processed 6,048 bill records from 356 unique vendors across 109 GL accounts
2. **Semantic Categorization**: Extracted 20 semantic categories using pattern matching and K-means clustering
3. **Hierarchical Rule System**: Built 4-level decision hierarchy as specified
4. **Decision Tree Algorithm**: Implemented optimized decision tree with overfitting prevention (58.7% accuracy)
5. **Rule Optimization**: Removed redundant rules and optimized feature importance
6. **Pattern Mining**: Analyzed historical feedback patterns across vendor types and amount thresholds

**Algorithm Features:**
- **Level 1**: Vendor + Semantic Category (most specific)
- **Level 2**: Vendor Type + Semantic Category
- **Level 3**: Semantic Category only
- **Level 4**: Amount-based rules (fallback)
- **Overfitting Prevention**: Cross-validation, min samples constraints, feature selection
- **Redundancy Removal**: Feature importance filtering, rule pruning

**Key Insights:**
- Technology expenses (1,065 items) and Office Supplies (429 items) are major categories
- 168 general vendors, 64 technology vendors identified
- Amount range: -$15K to $54B (outliers detected)
- Decision tree: 15 levels deep, 465 nodes for optimal complexity

\`\`\`json
{
  "semantic categories": "/Users/dmitryvedenyapin/Library/Application Support/pf-desktop/workspaces/dox8eiwqw6i5iful7tob96ra/semantic_categories.json",
  "analysis": "Successfully implemented a comprehensive GL account mapping algorithm that processes 6,048 financial records from 356 vendors across 109 GL accounts. The algorithm extracts 20 semantic categories using hybrid pattern matching and K-means clustering, classifies vendors into 8 types, and builds a 4-level hierarchical decision system. The optimized decision tree achieves 58.7% accuracy with overfitting prevention through cross-validation and feature selection. Key findings include Technology (1,065 items) and Office Supplies (429 items) as dominant expense categories, with effective rule optimization removing redundant patterns while maintaining decision accuracy. The system successfully mines historical patterns and provides automated GL account classification based on vendor characteristics, semantic content, and amount thresholds.",
  "code": "/Users/dmitryvedenyapin/Library/Application Support/pf-desktop/workspaces/dox8eiwqw6i5iful7tob96ra/gl_account_mapping_algorithm.py"
}
\`\`\``

    const result = extractJsonBlock(text)
    expect(result).not.toBeNull()
    expect(result!['semantic categories']).toContain('semantic_categories.json')
    expect(result!['analysis']).toContain('GL account mapping algorithm')
    expect(result!['code']).toContain('gl_account_mapping_algorithm.py')
  })
})

describe('extractPartialJson', () => {
  it('extracts complete string pairs from truncated JSON', () => {
    const raw = '{\n  "key1": "value1",\n  "key2": "trun'
    expect(extractPartialJson(raw)).toEqual({ key1: 'value1' })
  })

  it('extracts literal values', () => {
    const raw = '{"count": 42, "active": true, "name": null}'
    const result = extractPartialJson(raw)
    expect(result.count).toBe(42)
    expect(result.active).toBe(true)
    expect(result.name).toBeNull()
  })
})

describe('collectWrittenFiles', () => {
  it('collects file paths from write tool calls', () => {
    const messages = [
      {
        info: { role: 'assistant' },
        parts: [
          { type: 'tool', tool: 'Write', state: { status: 'completed', input: { file_path: '/tmp/out.json' } } },
          { type: 'tool', tool: 'Read', state: { status: 'completed', input: { file_path: '/tmp/in.json' } } }
        ]
      }
    ]
    expect(collectWrittenFiles(messages)).toEqual(['/tmp/out.json'])
  })

  it('skips incomplete tool calls', () => {
    const messages = [
      {
        info: { role: 'assistant' },
        parts: [
          { type: 'tool', tool: 'Write', state: { status: 'pending', input: { file_path: '/tmp/out.json' } } }
        ]
      }
    ]
    expect(collectWrittenFiles(messages)).toEqual([])
  })
})

describe('extractOutputFromMessages', () => {
  const fields = [
    { id: 'f1', name: 'semantic categories', type: 'file', required: true },
    { id: 'f2', name: 'analysis', type: 'text', required: true },
    { id: 'f3', name: 'code', type: 'file', required: true }
  ]

  it('extracts values from real agent output', () => {
    const messages = [
      {
        info: { role: 'assistant' },
        parts: [
          {
            type: 'text',
            text: `## Task Completion Summary

Done.

\`\`\`json
{
  "semantic categories": "/workspace/semantic_categories.json",
  "analysis": "Successfully implemented the algorithm.",
  "code": "/workspace/gl_mapping.py"
}
\`\`\``
          }
        ]
      }
    ]

    const result = extractOutputFromMessages(messages, fields)
    expect(result).not.toBeNull()
    expect(result![0].value).toBe('/workspace/semantic_categories.json')
    expect(result![1].value).toBe('Successfully implemented the algorithm.')
    expect(result![2].value).toBe('/workspace/gl_mapping.py')
  })

  it('returns null when no assistant messages', () => {
    expect(extractOutputFromMessages([], fields)).toBeNull()
  })

  it('returns null when no JSON block and no written files', () => {
    const messages = [
      { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'No JSON here' }] }
    ]
    expect(extractOutputFromMessages(messages, fields)).toBeNull()
  })

  it('matches fields case-insensitively', () => {
    const messages = [
      {
        info: { role: 'assistant' },
        parts: [{ type: 'text', text: '```json\n{"Semantic Categories": "val"}\n```' }]
      }
    ]
    const result = extractOutputFromMessages(messages, fields)
    expect(result![0].value).toBe('val')
  })

  it('falls back to written files for unfilled file fields', () => {
    const messages = [
      {
        info: { role: 'assistant' },
        parts: [
          { type: 'text', text: '```json\n{"analysis": "done"}\n```' },
          { type: 'tool', tool: 'Write', state: { status: 'completed', input: { file_path: '/tmp/result.py' } } }
        ]
      }
    ]
    const result = extractOutputFromMessages(messages, fields)
    expect(result![1].value).toBe('done')
    // file fields with no JSON value get the written file
    expect(result![0].value).toBe('/tmp/result.py')
    expect(result![2].value).toBe('/tmp/result.py')
  })

  it('searches last assistant message first', () => {
    const messages = [
      {
        info: { role: 'assistant' },
        parts: [{ type: 'text', text: '```json\n{"analysis": "old"}\n```' }]
      },
      {
        info: { role: 'assistant' },
        parts: [{ type: 'text', text: '```json\n{"analysis": "new"}\n```' }]
      }
    ]
    const result = extractOutputFromMessages(messages, fields)
    expect(result![1].value).toBe('new')
  })

  it('handles text split across multiple parts', () => {
    const messages = [
      {
        info: { role: 'assistant' },
        parts: [
          { type: 'text', text: 'Some summary\n```json\n{' },
          { type: 'text', text: '"analysis": "split value"}\n```' }
        ]
      }
    ]
    const result = extractOutputFromMessages(messages, fields)
    expect(result![1].value).toBe('split value')
  })
})
