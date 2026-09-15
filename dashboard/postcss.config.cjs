/**
 * Tailwind, for the reused POS screens.
 *
 * `.cjs` rather than `.js`: this package is `"type": "module"`, so a plain
 * postcss.config.js would be parsed as ESM and PostCSS would not find a config
 * at all — silently, leaving every Tailwind class inert.
 */
module.exports = {
  plugins: {
    tailwindcss: { config: './tailwind.config.cjs' },
    autoprefixer: {},
  },
};
