import { defineConfig } from 'vitest/config'

// Tests live at the repo root, outside the distributable skill folder, and
// import the code under test from ../bookmarks-to-obsidian/scripts/src.
export default defineConfig({
  test: {
    include: ['test/**/*.test.mjs'],
  },
})
