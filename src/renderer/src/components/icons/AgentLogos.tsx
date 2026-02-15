import opencodeIcon from '@/assets/logos/opencode.svg'
import anthropicIcon from '@/assets/logos/anthropic.svg'
import openaiIcon from '@/assets/logos/openai.svg'

export function OpenCodeLogo({ className }: { className?: string }) {
  return <img src={opencodeIcon} className={className} alt="OpenCode" />
}

export function AnthropicLogo({ className }: { className?: string }) {
  return <img src={anthropicIcon} className={className} alt="Anthropic" />
}

export function OpenAILogo({ className }: { className?: string }) {
  return <img src={openaiIcon} className={className} alt="OpenAI" />
}
