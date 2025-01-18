import path from 'node:path';
import { expect, test, describe, afterEach } from 'vitest';
import { AdvZlib } from '../src/adv-zlib';

describe('vdu_snapshot.zip', async () => {
  const vduSnapshotPath = path.join(process.cwd(), 'assets', 'vdu_snapshot.zip');
  const advZlib = new AdvZlib();
  const snapshotName = 'Snapshot_MRBTS-11162_5gvDU_TL171_vDUCNF25R1_0.300.25526_20240920-fault4261.zip';

  afterEach(async () => {
    await advZlib.cleanup();
  });

  test('Check if snapshot_file_list.txt exists', async () => {
    const entries = await advZlib.getEntries(vduSnapshotPath);
    expect(entries.length).toBe(1);

    const exists = await advZlib.exists(path.join(vduSnapshotPath, snapshotName, 'snapshot_file_list.txt'));
    expect(exists).toBeTruthy();
  });

  test('Check if nested file(under 50MB) exists', async () => {
    const target = path.join(vduSnapshotPath, snapshotName, 'RU_1.zip/BTS_DH214500033_RMOD_L_1_fault_history_log.txt.gz');
    const exists2 = await advZlib.exists(target);
    expect(exists2).toBeTruthy();
  });

  test('Check if nested file(over 50MB) exists', async () => {
    const target = path.join(vduSnapshotPath, snapshotName, 'RU_3.zip/BTS_YK223000045_RMOD_L_4_ccsrt-runtime.tar.gz');
    const exists2 = await advZlib.exists(target);
    expect(exists2).toBeTruthy();
  });
});
