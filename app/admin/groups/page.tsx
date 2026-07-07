import { redirect } from "next/navigation";

// V3.3：广告分组页已改为弹窗（?modal=groups）。旧路由重定向到首页深链。
export default function GroupsRedirect() {
  redirect("/?modal=groups");
}
