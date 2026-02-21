import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';
import fs from 'node:fs';
import path from 'node:path';

const isE2E = process.env.WXT_E2E === '1';
const chromiumProfileDir = path.resolve('.wxt/chromium-profile');
fs.mkdirSync(chromiumProfileDir, { recursive: true });

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  webExt: {
    chromiumProfile: chromiumProfileDir,
    keepProfileChanges: true,
  },
  manifest: () => {
    const brandingManifest = {
      name: 'Unity',
      short_name: 'Unity',
      description: 'Grounded tab chat for webpages and YouTube with source jump and inline highlight.',
      icons: {
        16: 'icon/16.png',
        32: 'icon/32.png',
        48: 'icon/48.png',
        96: 'icon/96.png',
        128: 'icon/128.png',
      },
      action: {
        default_title: 'Unity',
        default_popup: 'popup.html',
        default_icon: {
          16: 'icon/16.png',
          32: 'icon/32.png',
          48: 'icon/48.png',
          96: 'icon/96.png',
          128: 'icon/128.png',
        },
      },
      web_accessible_resources: [
        {
          resources: ['fonts/opendyslexic/*'],
          matches: ['http://*/*', 'https://*/*'],
        },
      ],
    };

    const productionManifest = {
      ...brandingManifest,
      permissions: ['activeTab', 'scripting', 'storage', 'tabs'],
      host_permissions: [
        'http://*/*',
        'https://*/*',
        'https://openrouter.ai/*',
        'https://www.youtube.com/*',
        'https://youtube.com/*',
        'https://m.youtube.com/*',
        'https://music.youtube.com/*',
      ],
    };

    if (!isE2E) {
      return productionManifest;
    }

    return {
      ...brandingManifest,
      permissions: ['scripting', 'tabs', 'storage'],
      host_permissions: [
        'http://*/*',
        'https://*/*',
        'https://openrouter.ai/*',
      ],
    };
  },
  vite: () => ({
    plugins: [tailwindcss()],
  }),
});
