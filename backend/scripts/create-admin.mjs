import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { db } from '../src/db/database.js';
import { closeDatabase } from '../src/db/database.js';

const rl = createInterface({ input: stdin, output: stdout });

try {
  const secret = process.env.INITIAL_ADMIN_SETUP_SECRET;

  if (!secret || secret.length < 32) {
    throw new Error('INITIAL_ADMIN_SETUP_SECRET is missing or too short in .env.');
  }

  const count = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;

  if (count !== 0) {
    throw new Error('A user already exists. Initial setup is no longer available.');
  }

  const name = (await rl.question('Administrator name: ')).trim();
  const email = (await rl.question('Administrator email: ')).trim().toLowerCase();
  const password = await rl.question('Administrator password (hidden input is not available in this script): ');

  if (name.length < 2 || name.length > 100) {
    throw new Error('Name must be between 2 and 100 characters.');
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw new Error('Enter a valid email address.');
  }

  if (password.length < 12 || password.length > 128) {
    throw new Error('Password must be between 12 and 128 characters.');
  }

  const response = await fetch('http://127.0.0.1:8788/api/auth/setup', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-setup-secret': secret,
    },
    body: JSON.stringify({ name, email, password }),
  });

  const result = await response.json();

  if (!response.ok) {
    throw new Error(`Setup failed (HTTP ${response.status}): ${result.error || 'Unknown error'}`);
  }

  console.log('\nAdministrator created successfully.');
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error('\n' + error.message);
  process.exitCode = 1;
} finally {
  rl.close();
  closeDatabase();
}
