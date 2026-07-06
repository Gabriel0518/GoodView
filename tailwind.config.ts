import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          950: "#08080a",
          900: "#0e0e12",
          850: "#141419",
          800: "#1b1b22",
          700: "#26262f",
          600: "#33333f",
        },
        accent: {
          DEFAULT: "#7c8cff",
          soft: "#9aa6ff",
        },
      },
      fontFamily: {
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
};
export default config;
