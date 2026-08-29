import assert from 'node:assert/strict'
import test from 'node:test'

import { isExactTransientWriteLockBusy } from './support/p4-installed-real.mjs'

test('installed-real hook polling retries only an exact transient write-lock collision', () => {
  assert.equal(isExactTransientWriteLockBusy({ status: 1, stdout: '', stderr: 'write lock is busy\r\n' }), true)
  assert.equal(isExactTransientWriteLockBusy({ status: 1, stdout: 'write lock is busy\n', stderr: '' }), true)

  for (const result of [
    { status: 0, stdout: '', stderr: 'write lock is busy' },
    { status: 2, stdout: '', stderr: 'write lock is busy' },
    { status: 1, stdout: 'extra output', stderr: 'write lock is busy' },
    { status: 1, stdout: '', stderr: 'application lock is busy' },
    { status: 1, stdout: '', stderr: 'write lock is busy', error: new Error('spawn failed') }
  ]) assert.equal(isExactTransientWriteLockBusy(result), false)
})
