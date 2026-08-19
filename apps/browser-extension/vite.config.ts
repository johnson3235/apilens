import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { copyFileSync, mkdirSync, existsSync } from 'fs';

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'copy-extension-files',
      writeBundle() {
        // Ensure dist directories exist
        mkdirSync(resolve(__dirname, 'dist/devtools'), { recursive: true });
        mkdirSync(resolve(__dirname, 'dist/popup'), { recursive: true });
        mkdirSync(resolve(__dirname, 'dist/icons'), { recursive: true });

        // Copy manifest
        copyFileSync(
          resolve(__dirname, 'src/manifest.json'),
          resolve(__dirname, 'dist/manifest.json')
        );

        // Copy HTML files
        copyFileSync(
          resolve(__dirname, 'src/devtools/devtools.html'),
          resolve(__dirname, 'dist/devtools/devtools.html')
        );
        copyFileSync(
          resolve(__dirname, 'src/devtools/panel.html'),
          resolve(__dirname, 'dist/devtools/panel.html')
        );
        copyFileSync(
          resolve(__dirname, 'src/popup/popup.html'),
          resolve(__dirname, 'dist/popup/popup.html')
        );

        // Copy icons if present
        [16, 48, 128].forEach(size => {
          const srcIcon = resolve(__dirname, `src/icons/icon${size}.png`);
          if (existsSync(srcIcon)) {
            copyFileSync(srcIcon, resolve(__dirname, `dist/icons/icon${size}.png`));
          }
        });
      },
    },
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        'background/service-worker': resolve(__dirname, 'src/background/service-worker.ts'),
        'devtools/devtools': resolve(__dirname, 'src/devtools/devtools.ts'),
        'devtools/panel': resolve(__dirname, 'src/devtools/panel.tsx'),
        'popup/popup': resolve(__dirname, 'src/popup/popup.tsx'),
        'content/content-script': resolve(__dirname, 'src/content/content-script.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
});
