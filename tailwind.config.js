/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{vue,js}'],
  theme: {
    extend: {
      colors: {
        // ===== 表面明度阶梯（圆角方案 V2）=====
        // V2 用「卡片明显浮起」代替「描边切分」：卡片比页面亮更多，描边只作极淡收边。
        'bg-primary': '#0B0B0E',
        'bg-secondary': '#121216',
        'bg-card': '#1E1E25',
        'bg-hover': '#292930',
        'bg-elevated': '#32323B',
        border: '#33333C',
        'border-light': '#45454F',
        'border-strong': '#5A5A65',

        // ===== 文字（对比度全部 ≥ 4.5:1，弱化层级不破 3.5:1）=====
        'text-primary': '#EDEDF0',
        'text-secondary': '#A8A8B3',
        'text-muted': '#7E7E8C',

        // ===== 强调色（主操作 / 已完成锁定）=====
        accent: '#C8F542',
        'accent-hover': '#D6FF5C',
        'accent-dim': '#9BC22F',

        // ===== 语义色（5 档收敛，不再散用 tailwind 默认色阶）=====
        // info：信息 / 处理中    warn：注意 / 待确认
        // danger：失败 / 需处置  ok：完成 / 已验收
        info: '#5B9DF9',
        'info-dim': '#2F6FBF',
        warn: '#E8A33D',
        'warn-dim': '#B37A22',
        danger: '#F0655F',
        'danger-dim': '#B8443F',
        ok: '#4ECB8E',
        'ok-dim': '#2F9268',
      },
      fontSize: {
        // 字号阶梯：下限 11px（可读性红线），不再出现 9px / 10px
        micro: ['11px', { lineHeight: '16px', letterSpacing: '0.02em' }],
        '2xs': ['12px', { lineHeight: '18px' }],
      },
      borderRadius: {
        // ===== 圆角方案 V2（对齐画风 / 设定页的圆润语言）=====
        // 全站不再出现直角方块；标签与徽章一律 pill，容器走大圆角 + 柔和阴影。
        tag: '10px', // 小标签
        control: '12px', // 输入 / 小控件
        btn: '16px', // 按钮 / 输入框（与画风页 rounded-xl 一致）
        panel: '20px', // 面板 / 弹出层
        card: '24px', // 卡片 / 大容器
        shell: '28px', // 页面级大容器 / 模态
        pill: '999px', // 徽章 / 开关 / 计数
      },
      boxShadow: {
        // V2：以柔和阴影承担分层职责，描边仅作极淡的收边
        card: '0 2px 8px -2px rgb(0 0 0 / 0.45)',
        'card-hover': '0 12px 32px -8px rgb(0 0 0 / 0.62)',
        pop: '0 24px 64px -16px rgb(0 0 0 / 0.78)',
        inset: 'inset 0 1px 0 0 rgb(255 255 255 / 0.04)',
        // 键盘焦点环，统一可达性表现
        'focus-accent': '0 0 0 3px rgb(11 11 13 / 0.9), 0 0 0 6px rgb(200 245 66 / 0.55)',
        'focus-info': '0 0 0 3px rgb(11 11 13 / 0.9), 0 0 0 6px rgb(91 157 249 / 0.55)',
      },
      keyframes: {
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
      animation: {
        'fade-up': 'fade-up 0.18s ease-out',
        shimmer: 'shimmer 1.6s linear infinite',
      },
    },
  },
  plugins: [],
}
