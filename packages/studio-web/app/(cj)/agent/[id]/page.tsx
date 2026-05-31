import { redirect } from "next/navigation"

// 单 Agent 详情页已并入「编辑部成员中心」(/agents)的主从面板(角色栏 + 提示词 + 模型&Key + 版本),
// 这里去重:任何 /agent/<id> 访问直接重定向到成员中心,避免两套重复的 agent 编辑界面。
export default function AgentDetailRedirect() {
  redirect("/agents")
}
