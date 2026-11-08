/**
 * Auto-update gate — Meridian's rule transplanted: only a clean checkout of
 * the default branch self-updates; everything else reports blocked and the
 * tree is never touched.
 */

import { describe, expect, it } from 'vitest';
import { autoUpdateBlockReason } from '../update/checker.js';

const base = { isDocker: false, branch: 'main', defaultBranch: 'main', dirty: false, enabled: true };

describe('autoUpdateBlockReason', () => {
  it('allows a clean default-branch checkout', () => {
    expect(autoUpdateBlockReason(base)).toBeNull();
  });

  it('blocks when disabled, docker, feature branch, dirty, or detached', () => {
    expect(autoUpdateBlockReason({ ...base, enabled: false })).toMatch(/disabled/);
    expect(autoUpdateBlockReason({ ...base, isDocker: true })).toMatch(/docker/);
    expect(autoUpdateBlockReason({ ...base, branch: 'feat/x' })).toMatch(/feat\/x, not main/);
    expect(autoUpdateBlockReason({ ...base, dirty: true })).toMatch(/uncommitted/);
    expect(autoUpdateBlockReason({ ...base, branch: '' })).toMatch(/not a git checkout/);
  });

  it('respects a non-main default branch', () => {
    expect(autoUpdateBlockReason({ ...base, branch: 'trunk', defaultBranch: 'trunk' })).toBeNull();
    expect(autoUpdateBlockReason({ ...base, branch: 'main', defaultBranch: 'trunk' })).toMatch(/not trunk/);
  });
});
