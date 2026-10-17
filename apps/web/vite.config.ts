import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5173 },
  build: {
    target: 'es2022',
    sourcemap: false,
    // Two pages: the game (index.html) and the Locker (locker.html) until W4's shell routes them.
    rolldownOptions: { input: { main: 'index.html', locker: 'locker.html' } },
  },
});
