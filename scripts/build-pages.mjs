import { cpSync, copyFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'build', 'pages');
mkdirSync(output, { recursive: true });
cpSync(resolve(root, 'demo'), output, { recursive: true });

for (const file of ['TimezoneClient.js', 'world.tzdb']) {
  copyFileSync(resolve(root, 'dist', file), resolve(output, file));
}
copyFileSync(resolve(root, 'DATA-LICENSE.txt'), resolve(output, 'DATA-LICENSE.txt'));
copyFileSync(resolve(root, 'THIRD-PARTY-NOTICES.txt'), resolve(output, 'THIRD-PARTY-NOTICES.txt'));
