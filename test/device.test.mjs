import test from 'node:test';
import assert from 'node:assert/strict';
import { deviceBounds, emulationOf, isDevice } from '../src/main/device.js';

const AREA = { x: 0, y: 80, width: 1280, height: 700 };

test('deviceBounds：电脑铺满，手机/平板按宽度居中，内容区太窄时铺满', () => {
  assert.deepEqual(deviceBounds(AREA, 'desktop'), AREA);
  assert.deepEqual(deviceBounds(AREA, 'phone'), { x: 445, y: 80, width: 390, height: 700 });
  assert.deepEqual(deviceBounds(AREA, 'tablet'), { x: 230, y: 80, width: 820, height: 700 });
  const narrow = { x: 0, y: 80, width: 600, height: 700 };
  assert.deepEqual(deviceBounds(narrow, 'tablet'), narrow);
  assert.deepEqual(deviceBounds(AREA, 'unknown'), AREA);
});

test('emulationOf：电脑不仿真，手机按移动设备仿真，视口跟实际区域一致', () => {
  assert.equal(emulationOf('desktop', AREA), null);
  const em = emulationOf('phone', { width: 390, height: 700 });
  assert.equal(em.screenPosition, 'mobile');
  assert.deepEqual(em.screenSize, { width: 390, height: 844 });
  assert.deepEqual(em.viewSize, { width: 390, height: 700 });
});

test('isDevice：只认三种尺寸，不认原型链上的键', () => {
  for (const d of ['desktop', 'tablet', 'phone']) assert.ok(isDevice(d));
  for (const d of ['toString', '', undefined, 'watch']) assert.ok(!isDevice(d));
});
