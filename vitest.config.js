import { defineConfig } from 'vitest/config';

/**
 * Two-tier test setup for the vanilla-JS PWA:
 *   - "unit" — pure math/logic (layout.js, compressor constants) in plain Node.
 *   - "dom"  — real index.html + app.js in jsdom with stubbed canvas stages.
 * The real-browser tier stays in _selftest/ (python _selftest/run_selftest.py).
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/unit/**/*.test.js'],
        },
      },
      {
        test: {
          name: 'dom',
          environment: 'jsdom',
          include: [
            'tests/integration/**/*.test.js',
            'tests/ui/**/*.test.js',
            'tests/lib/**/*.test.js',
          ],
        },
      },
    ],
  },
});
