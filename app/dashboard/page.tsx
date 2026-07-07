import { redirect } from "next/navigation";

// v3：看板列表页并入桌面画布（首页）。旧链接重定向。
export default function Page() {
  redirect("/");
}
