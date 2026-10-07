const { cpSync, mkdirSync } = require('node:fs');
const { dirname } = require('node:path');

const target = 'dist/db/migrations/001_initial.sql';
mkdirSync(dirname(target), { recursive: true });
cpSync('src/db/migrations/001_initial.sql', target);
