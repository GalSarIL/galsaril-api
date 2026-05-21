#!/usr/bin/env node
// Node 18+ required (uses globalThis.crypto)
import { createInterface } from 'readline';

const rl = createInterface({ input: process.stdin, output: process.stdout });

function toHex(buf) {
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

rl.question('Username [admin]: ', (username) => {
  username = username.trim() || 'admin';
  process.stdout.write('Password: ');
  process.stdin.setRawMode?.(true);

  let password = '';
  process.stdin.on('data', async (ch) => {
    const c = ch.toString();
    if (c === '\r' || c === '\n') {
      process.stdin.setRawMode?.(false);
      process.stdout.write('\n');
      rl.close();

      const salt = globalThis.crypto.getRandomValues(new Uint8Array(32));
      const key = await globalThis.crypto.subtle.importKey(
        'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
      );
      const hash = await globalThis.crypto.subtle.deriveBits(
        { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 600_000 }, key, 256
      );
      const stored = `pbkdf2:600000:${toHex(salt.buffer)}:${toHex(hash)}`;
      console.log('\n--- Run this command ---');
      console.log(`wrangler kv key put --binding=AUTH_KV "credentials:${username}" '${stored}'\n`);
    } else if (c === '\x7f') {
      password = password.slice(0, -1);
    } else {
      password += c;
    }
  });
  process.stdin.resume();
});
