// ルート表 (1 か所だけ)。画面を足すときはここに 1 行足す。上から順に見て最初に一致したものを出す。
import type { Route } from "./router";
import { AssetScreen } from "./screens/AssetScreen";
import { ContainerScreen } from "./screens/ContainerScreen";
import { Home } from "./screens/Home";
import { MoveScreen } from "./screens/MoveScreen";

export const routes: Route[] = [
  { pattern: "/", screen: Home },
  { pattern: "/app", screen: Home },
  { pattern: "/app/c/:id", screen: ContainerScreen },
  { pattern: "/app/a/:id", screen: AssetScreen },
  { pattern: "/app/move", screen: MoveScreen },
];
