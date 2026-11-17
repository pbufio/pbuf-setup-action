/**
 * Unit tests for the action's entrypoint, src/index.js
 */

// Mock the action's entrypoint
jest.mock('../src/main', () => ({
  run: jest.fn()
}))

const { run } = require('../src/main')

describe('index', () => {
  it('calls run when imported', async () => {
    require('../src/index')

    expect(run).toHaveBeenCalled()
  })
})
