import { redirect } from "next/navigation";

// V3.3：事件配置页已改为弹窗（?modal=events）。旧路由重定向到首页深链。
export default function EventsRedirect() {
  redirect("/?modal=events");
}
