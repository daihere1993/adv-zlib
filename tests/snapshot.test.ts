import path from 'node:path';
import { expect, test } from 'vitest';
import { AdvZlib } from '../src/adv-zlib';

test('vdu_snapshot.zip', async () => {
  const vduSnapshotPath = path.join(process.cwd(), 'assets', 'vdu_snapshot.zip');
  const advZlib = new AdvZlib();

  const entries = await advZlib.getEntries(vduSnapshotPath);
  expect(entries.length).toBe(1);
  const firstEntry = entries[0].name;
  const exists = await advZlib.exists(path.join(vduSnapshotPath, firstEntry, 'snapshot_file_list.txt'));
  expect(exists).toBeTruthy();
});
