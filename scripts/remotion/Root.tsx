import React from 'react'
import { Composition } from 'remotion'
import { DataFilePreviewScreenshot } from './DataFilePreviewScreenshot'

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="DataFilePreview"
        component={DataFilePreviewScreenshot}
        durationInFrames={1}
        fps={1}
        width={1200}
        height={700}
      />
    </>
  )
}
