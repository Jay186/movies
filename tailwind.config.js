export default {
  content: ['./index.html', './src/**/*.{vue,js}'],
  theme: {
    extend: {
      colors: {
        'bg-primary': '#0B0B0E',
        'bg-secondary': '#121216',
        'bg-card': '#1E1E25',
        'bg-hover': '#292930',
        'bg-elevated': '#32323B',
        border: '#33333C',
        'border-light': '#45454F',
        'border-strong': '#5A5A65',

        'text-primary': '#EDEDF0',
        'text-secondary': '#A8A8B3',
        'text-muted': '#7E7E8C',

        accent: '#C8F542',
        'accent-hover': '#D6FF5C',
        'accent-dim': '#9BC22F',

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
        micro: ['11px', { lineHeight: '16px', letterSpacing: '0.02em' }],
        '2xs': ['12px', { lineHeight: '18px' }],
      },
      borderRadius: {
        tag: '10px', 
        control: '12px', 
        btn: '16px', 
        panel: '20px', 
        card: '24px', 
        shell: '28px', 
        pill: '999px', 
      },
      boxShadow: {
        card: '0 2px 8px -2px rgb(0 0 0 / 0.45)',
        'card-hover': '0 12px 32px -8px rgb(0 0 0 / 0.62)',
        pop: '0 24px 64px -16px rgb(0 0 0 / 0.78)',
        inset: 'inset 0 1px 0 0 rgb(255 255 255 / 0.04)',
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
