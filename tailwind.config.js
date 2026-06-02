/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        champagne: '#f6d88a',
        bronze: '#b78628',
        onyx: '#050505',
        graphite: '#111111'
      },
      boxShadow: {
        glow: '0 0 40px rgba(246, 216, 138, 0.16)',
        gold: '0 20px 50px rgba(183, 134, 40, 0.18)'
      },
      fontFamily: {
        display: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif']
      },
      keyframes: {
        fadeUp: {
          '0%': { opacity: '0', transform: 'translateY(22px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' }
        },
        slowPan: {
          '0%, 100%': { transform: 'scale(1.03) translateX(0)' },
          '50%': { transform: 'scale(1.08) translateX(-12px)' }
        }
      },
      animation: {
        fadeUp: 'fadeUp 700ms ease both',
        slowPan: 'slowPan 16s ease-in-out infinite'
      }
    }
  },
  plugins: []
};
