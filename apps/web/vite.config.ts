import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5173 },
  build: {
    target: 'es2022',
    sourcemap: false,
    // Pages: the game (index.html), the Locker (locker.html) and the Armory (armory.html) until W4's shell routes them.
    rolldownOptions: { input: { main: 'index.html', locker: 'locker.html', armory: 'armory.html' } },
  },
});
