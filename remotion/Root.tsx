import { Composition } from 'remotion'
import { SidebarSubtasks } from './SidebarSubtasks'
import { DetailViewSubtasks } from './DetailViewSubtasks'
import { SubtaskNavigation } from './SubtaskNavigation'

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="SidebarSubtasks"
        component={SidebarSubtasks}
        durationInFrames={1}
        fps={30}
        width={1280}
        height={800}
      />
      <Composition
        id="DetailViewSubtasks"
        component={DetailViewSubtasks}
        durationInFrames={1}
        fps={30}
        width={1280}
        height={800}
      />
      <Composition
        id="SubtaskNavigation"
        component={SubtaskNavigation}
        durationInFrames={1}
        fps={30}
        width={1280}
        height={800}
      />
    </>
  )
}
