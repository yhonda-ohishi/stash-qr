// ルート表 (1 か所だけ)。画面を足すときはここに 1 行足す。上から順に見て最初に一致したものを出す。
import type { Route } from "./router";
import { AssetScreen } from "./screens/AssetScreen";
import { ContainerScreen } from "./screens/ContainerScreen";
import { Home } from "./screens/Home";
import { JudgeScreen } from "./screens/JudgeScreen";
import { LabelScreen } from "./screens/LabelScreen";
import { MoveScreen } from "./screens/MoveScreen";
import { NewContainerScreen } from "./screens/NewContainerScreen";
import { SettingsScreen } from "./screens/SettingsScreen";

export const routes: Route[] = [
  { pattern: "/", screen: Home },
  { pattern: "/app", screen: Home },
  { pattern: "/app/new", screen: NewContainerScreen },
  { pattern: "/app/c/:id", screen: ContainerScreen },
  { pattern: "/app/a/:id", screen: AssetScreen },
  { pattern: "/app/move", screen: MoveScreen },
  { pattern: "/app/c/:id/judge", screen: JudgeScreen },
  { pattern: "/app/label", screen: LabelScreen },
  { pattern: "/app/settings", screen: SettingsScreen },
];
