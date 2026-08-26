import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MOBILE_PROFILE,
  DESKTOP_PROFILE,
  applyTilesetProfile,
  disableAllPostProcess,
  wantsDiagOverlay,
} from './mobileProfile.js';

// The desktop values are the upstream ones; if someone changes them in main.js
// this test is the reminder to change them here too.
test('profiles: mobile is lighter than the desktop defaults', () => {
  assert.equal(DESKTOP_PROFILE.msaaSamples, 4);
  assert.equal(DESKTOP_PROFILE.preserveDrawingBuffer, true);
  assert.equal(DESKTOP_PROFILE.disablePostProcess, false);
  assert.equal(MOBILE_PROFILE.msaaSamples, DESKTOP_PROFILE.msaaSamples, 'MSAA is kept on phones');
  assert.equal(MOBILE_PROFILE.preserveDrawingBuffer, false);
  assert.ok(MOBILE_PROFILE.tilesetCacheBytes > 0);
  assert.equal(MOBILE_PROFILE.disablePostProcess, true);
});

// A null limit means "leave Cesium's default", so the desktop profile must
// not write anything.
test('applyTilesetProfile: desktop leaves the tileset untouched, mobile bounds it', () => {
  const tileset = { cacheBytes: 1, maximumCacheOverflowBytes: 2, maximumScreenSpaceError: 16 };

  applyTilesetProfile(tileset, DESKTOP_PROFILE);
  assert.deepEqual(tileset, { cacheBytes: 1, maximumCacheOverflowBytes: 2, maximumScreenSpaceError: 16 });

  applyTilesetProfile(tileset, MOBILE_PROFILE);
  assert.equal(tileset.cacheBytes, MOBILE_PROFILE.tilesetCacheBytes);
  assert.equal(tileset.maximumCacheOverflowBytes, MOBILE_PROFILE.tilesetMaximumCacheOverflowBytes);
  assert.equal(tileset.maximumScreenSpaceError, MOBILE_PROFILE.tilesetMaximumScreenSpaceError);

  assert.doesNotThrow(() => applyTilesetProfile(null, MOBILE_PROFILE));
});

// No Cesium here: the double only mimics the shape of
// PostProcessStageCollection that the function relies on (length, get(index),
// and the built-in fxaa and bloom stages that live outside the indexed list).
test('disableAllPostProcess: switches every enabled stage off and reports the count', () => {
  const stages = [{ enabled: true }, { enabled: false }, { enabled: true }];
  const viewer = {
    scene: {
      postProcessStages: {
        length: stages.length,
        get: (index) => stages[index],
        fxaa: { enabled: true },
        bloom: { enabled: true },
      },
    },
  };

  // Two were on, one was already off: the count reports only what changed.
  assert.equal(disableAllPostProcess(viewer), 2);
  assert.ok(stages.every((stage) => !stage.enabled));
  assert.equal(viewer.scene.postProcessStages.fxaa.enabled, false);
  assert.equal(viewer.scene.postProcessStages.bloom.enabled, false);

  assert.equal(disableAllPostProcess({}), 0);
});

// Share links keep their state in the hash, so the flag has to be found there
// too.
test('wantsDiagOverlay: only with ?gevFlags=diag, in query or hash', () => {
  assert.equal(wantsDiagOverlay('https://x/?gevFlags=diag'), true);
  assert.equal(wantsDiagOverlay('https://x/#v=2&gevFlags=Diag'), true);
  assert.equal(wantsDiagOverlay('https://x/?gevFlags=other'), false);
  assert.equal(wantsDiagOverlay('https://x/'), false);
  assert.equal(wantsDiagOverlay(''), false);
});
