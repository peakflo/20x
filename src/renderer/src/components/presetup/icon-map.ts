import { Calculator, UserPlus, Package, Brain, type LucideIcon } from 'lucide-react'

const iconMap: Record<string, LucideIcon> = {
  Calculator,
  UserPlus,
  Package,
  Brain
}

export function getTemplateIcon(iconName: string): LucideIcon {
  return iconMap[iconName] || Package
}
