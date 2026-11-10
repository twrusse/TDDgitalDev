import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { findSecrets } from '../scripts/check-secrets.js';

test('the repository does not contain Stripe API keys or webhook secrets', async () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const hits = await findSecrets(root);
  assert.deepEqual(hits, []);
});
