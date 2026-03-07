import { Composition } from "remotion";
import { PluginsShowcase } from "./PluginsShowcase";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="PluginsShowcase"
        component={PluginsShowcase}
        durationInFrames={600}
        fps={30}
        width={1920}
        height={1080}
      />
    </>
  );
};
