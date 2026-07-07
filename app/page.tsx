"use client";

// v2 首页 = 看板列表（自助搭建器入口）。v1 旧版看板灰度期保留在 /legacy。
import { BoardList } from "./components/board/BoardList";

export default function Home() {
  return <BoardList />;
}
