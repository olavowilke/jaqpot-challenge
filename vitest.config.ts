import 'dotenv/config';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Run e2e tests serially — they share the seeded wallet row.
    fileParallelism: false,
    testTimeout: 20_000,
    // Container startup + migrations on first beforeAll can take a while.
    hookTimeout: 120_000,
  },
});
