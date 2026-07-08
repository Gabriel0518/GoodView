// 验证新过滤格式对全量口径（doc §8 窗口 06-23~07-07, ET, all 去重, 排测试）是否对得上。
import { postAnalysis, buildEventFilter } from "./lib/byteplus.mjs";
import { BYTEPLUS } from "./config.mjs";
const TS_START="1782187200", TS_END="1783483199";
const IS_TEST={expression:{logic:"and",expressions:[
  {logic:"or",conditions:[{property_type:"profile",property_name:"is_test",property_compose_type:"origin",property_operation:"!=",property_values:["true"]}]},
  {logic:"or",conditions:[{property_type:"event_param",property_name:"isTest",property_compose_type:"origin",property_operation:"!=",property_values:["true"]}]},
]}};
async function total(ev, filters){
  const dsl={use_app_cloud_id:true,app_ids:[BYTEPLUS.appId],version:3,
    periods:[{granularity:"all",type:"past_range",spans:[{type:"timestamp",timestamp:TS_START},{type:"timestamp",timestamp:TS_END}],timezone:"US/Eastern",week_start:1,align_unit:"day",skip_period:false}],
    content:{query_type:"event",queries:[[{event_name:ev,event_type:"origin",show_name:ev,groups_v2:[],filters:buildEventFilter(filters),show_label:"A",event_indicator:"event_users",measure_info:{},indicator_show_name:""}]],
    profile_groups_v2:[],profile_filters:[IS_TEST],orders:[],page:{limit:1000,offset:0},option:{refresh_cache:false,fusion:false}}};
  const r=await postAnalysis(dsl); const d=r.data?.[0]?.data_item_list?.[0]; return d?.sum ?? d?.data?.[0] ?? 0;
}
const chk=async(name,ev,filters,expect)=>{const v=await total(ev,filters);console.log(`  ${name.padEnd(22)} = ${String(v).padStart(6)}  (doc §8: ${expect})`);await new Promise(r=>setTimeout(r,400));};
console.log("=== 全量口径校验 vs doc §8 (06-23~07-07 ET all 去重 排测试) ===");
await chk("投广页曝光 A","pwa_conv_lp_show",null,"34,529");
await chk("注册 Q","pwa_conv_cash_ready_pop_show",null,"5,315");
await chk("首提 wd=0.5","pwa_withdraw_audit_apply",[{property:"withdraw_amount",values:[0.5]}],"4,468");
await chk("成材 25|Stage5","pwa_withdraw_audit_apply",[{property:"withdraw_amount",values:[25]},{property:"will_cashout_stage",values:["CashoutStageFive"]}],"131");
await chk("任务2 4,5.5,7","pwa_withdraw_audit_apply",[{property:"withdraw_amount",values:[4,5.5,7]}],"?");
console.log("--- task_id 类型（IG绑定 110）---");
await chk("绑定Ins 数字110","pwa_task_complete",[{property:"task_id",values:[110]}],"vs字符");
await chk("绑定Ins 字符110","pwa_task_complete",[{property:"task_id",values:["110"]}],"vs数字");
process.exit(0);
