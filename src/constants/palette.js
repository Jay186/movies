// 角色色板：新增角色时按下标循环取色（全项目唯一来源）
// 消费方：stores/project.js（资产提取）、views/SettingsView.vue（手动/批量添加角色）
export const CHARACTER_COLOR_PALETTE = ['#6b9bd1', '#e8a849', '#a86bd1', '#6bd1a8']

// 按下标取角色色（越界自动循环）
export function characterColor(index) {
  return CHARACTER_COLOR_PALETTE[index % CHARACTER_COLOR_PALETTE.length]
}
