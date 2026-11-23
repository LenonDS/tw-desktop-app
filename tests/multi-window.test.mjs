import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isTribalWarsUrl } = require('../dist-electron/sessionManager.js');

test('Multi-Window URL routing: distinguishes internal Tribal Wars URLs from external links', () => {
  const domain = 'tribalwars.com.br';
  const world = 'br128';

  // In-game world URLs
  assert.equal(
    isTribalWarsUrl('https://br128.tribalwars.com.br/game.php?screen=place', domain, world),
    true,
    'Game screen should be recognized as internal TW URL'
  );
  assert.equal(
    isTribalWarsUrl('https://br128.tribalwars.com.br/game.php?screen=map', domain, world),
    true,
    'Map screen should be recognized as internal TW URL'
  );
  assert.equal(
    isTribalWarsUrl('https://tribalwars.com.br/page/rules', domain, world),
    true,
    'Main domain page should be recognized as internal TW URL'
  );
  assert.equal(
    isTribalWarsUrl('https://forum.tribalwars.com.br/index.php', domain, world),
    true,
    'Forum subdomain should be recognized as internal TW URL'
  );
  assert.equal(
    isTribalWarsUrl('https://innogames.com/games/tribal-wars', domain, world),
    true,
    'InnoGames publisher link should be recognized as internal TW URL'
  );

  // External URLs (should open in user default browser, not TW game window)
  assert.equal(
    isTribalWarsUrl('https://www.google.com/search?q=tribal+wars', domain, world),
    false,
    'Google search should NOT be treated as internal TW URL'
  );
  assert.equal(
    isTribalWarsUrl('https://discord.gg/tribalwars', domain, world),
    false,
    'Discord invite should NOT be treated as internal TW URL'
  );
  assert.equal(
    isTribalWarsUrl('https://twstats.com/br128/index.php', domain, world),
    false,
    'TWStats external tool should NOT be treated as internal TW URL'
  );

  // Malformed / empty inputs
  assert.equal(isTribalWarsUrl('', domain, world), false);
  assert.equal(isTribalWarsUrl('javascript:void(0)', domain, world), false);
  assert.equal(isTribalWarsUrl('not a url', domain, world), false);
});

test('Multi-Window Lifecycle: promotion of extra window when primary closes', () => {
  // Simulate ManagedSession window tracking
  class MockWindow {
    constructor(id) {
      this.id = id;
      this.destroyed = false;
      this.visible = true;
    }
    isDestroyed() {
      return this.destroyed;
    }
    isVisible() {
      return this.visible;
    }
    close() {
      this.destroyed = true;
      this.visible = false;
    }
  }

  const primaryWin = new MockWindow('primary');
  const extraWin1 = new MockWindow('extra-1');
  const extraWin2 = new MockWindow('extra-2');

  const session = {
    accountId: 'acc-1',
    window: primaryWin,
    extraWindows: new Set([extraWin1, extraWin2]),
    status: 'running',
  };

  assert.equal(session.extraWindows.size, 2);
  assert.equal(session.window.id, 'primary');

  // Case 1: Closing a secondary window removes it from extraWindows
  extraWin1.close();
  session.extraWindows.delete(extraWin1);
  assert.equal(session.extraWindows.size, 1);
  assert.equal(session.window.id, 'primary');
  assert.equal(session.status, 'running');

  // Case 2: Primary window is closed -> promotion of next extra window to primary
  primaryWin.close();
  if (session.extraWindows.size > 0) {
    const nextWin = session.extraWindows.values().next().value;
    session.extraWindows.delete(nextWin);
    session.window = nextWin;
  }

  assert.equal(session.window.id, 'extra-2');
  assert.equal(session.window.isDestroyed(), false);
  assert.equal(session.extraWindows.size, 0);
  assert.equal(session.status, 'running');

  // Case 3: Last window closes -> session goes offline
  session.window.close();
  if (session.extraWindows.size === 0 && session.window.isDestroyed()) {
    session.status = 'offline';
  }
  assert.equal(session.status, 'offline');
});
