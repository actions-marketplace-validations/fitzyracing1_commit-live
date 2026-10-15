#!/usr/bin/env node
import { main } from './main.mjs';

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`::error::commit-live: ${e.message}`);
    process.exit(2);
  },
);
