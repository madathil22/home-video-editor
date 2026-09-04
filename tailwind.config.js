/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        panel: "#1b1d23",
        panelAlt: "#22252d",
        edge: "#31353f",
        accent: "#4f8cff",
      },
    },
  },
  plugins: [],
};
