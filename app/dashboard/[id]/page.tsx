import { redirect } from "next/navigation";

// v3：看板详情改为画布上的弹窗。旧链接重定向到深链 /?board=id。
export default function Page({ params }: { params: { id: string } }) {
  redirect(`/?board=${params.id}`);
}
