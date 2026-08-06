import { File, FileCode2, FileImage, FileText, GitPullRequest } from 'lucide-react'
import { ArtifactType } from '@shared/artifacts'
import type { LucideIcon } from 'lucide-react'

export const ARTIFACT_ICONS: Record<ArtifactType, LucideIcon> = {
  [ArtifactType.MARKDOWN]: FileText,
  [ArtifactType.IMAGE]: FileImage,
  [ArtifactType.HTML]: FileCode2,
  [ArtifactType.PR]: GitPullRequest,
  [ArtifactType.FILE]: File
}
