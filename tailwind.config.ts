import type { Config } from "tailwindcss";

// v2 浅色 SaaS 设计系统（UI-设计需求.md §2）。语义命名，全项目用语义类。
// 迁移期保留旧 ink/accent-* 深色名，组件逐步迁到语义名后再移除。
const config: Config = {
  content: ["./app/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // —— 语义 token（浅色）——
        canvas: "#F7F8FA", // 页面背景
        surface: "#FFFFFF", // 卡片/面板
        subtle: "#F3F4F6", // 下沉区/表头/hover/输入底
        border: {
          DEFAULT: "#E5E7EB", // 主边框
          hair: "#EEF0F2", // 表格行线
        },
        strong: "#111827", // 标题
        body: "#374151", // 正文
        muted: "#6B7280", // 次要
        faint: "#9CA3AF", // 占位/禁用
        accent: {
          DEFAULT: "#4F46E5", // indigo-600 主按钮/选中/链接
          600: "#4338CA", // hover 加深
          soft: "#EEF2FF", // 选中/标签浅底 indigo-50
        },
        success: { DEFAULT: "#16A34A", soft: "#F0FDF4" },
        danger: { DEFAULT: "#DC2626", soft: "#FEF2F2" },
        warning: { DEFAULT: "#D97706", soft: "#FFFBEB" },
        info: { DEFAULT: "#2563EB", soft: "#EFF6FF" },

        // —— 迁移期保留：旧深色名（组件迁完后删）——
        ink: {
          950: "#08080a",
          900: "#0e0e12",
          850: "#141419",
          800: "#1b1b22",
          700: "#26262f",
          600: "#33333f",
        },
      },
      fontFamily: {
        sans: ["Inter", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      boxShadow: {
        // SaaS 关键：极浅阴影
        sm: "0 1px 2px rgba(16,24,40,.05)",
        md: "0 4px 12px rgba(16,24,40,.08), 0 1px 3px rgba(16,24,40,.06)",
        hover: "0 2px 8px rgba(16,24,40,.06)",
      },
      // 数据可视化调色板（多序列按序取）
      // #4F46E5 accent, #0EA5E9, #10B981, #F59E0B, #EC4899, #8B5CF6, #64748B
    },
  },
  plugins: [],
};
export default config;
