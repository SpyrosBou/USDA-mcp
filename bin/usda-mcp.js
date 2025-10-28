#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const distEntry = path.resolve(currentDir, '..', 'dist', 'server.js');

if (!fs.existsSync(distEntry)) {
  console.error('Build output missing at dist/server.js. Run `npm run build` before launching the MCP server.');
  process.exit(1);
}

await import(distEntry);
