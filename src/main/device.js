// 设备尺寸：有的网站只做了手机版，标签可以切到手机/平板宽度，网页在内容区里居中显示。
// 不依赖 Electron，方便测试。

export const DEVICES = {
  desktop: null,
  tablet: { width: 820, height: 1180 },
  phone: { width: 390, height: 844 },
};

export const isDevice = (d) => Object.hasOwn(DEVICES, d);

/** 内容区 area 里，按设备宽度居中后的网页区域。内容区不够宽时铺满 */
export function deviceBounds(area, device) {
  const d = DEVICES[device];
  if (!d || area.width <= d.width) return area;
  return { x: area.x + Math.floor((area.width - d.width) / 2), y: area.y, width: d.width, height: area.height };
}

/** webContents.enableDeviceEmulation 的参数：让 screen.width 等屏幕信息也像移动设备（不含触摸和 UA）；电脑尺寸返回 null。
 * view 是网页区域实际大小（deviceBounds 的结果） */
export function emulationOf(device, view) {
  const d = DEVICES[device];
  if (!d) return null;
  return {
    screenPosition: 'mobile',
    screenSize: { width: d.width, height: d.height },
    viewSize: { width: view.width, height: view.height },
    viewPosition: { x: 0, y: 0 },
    deviceScaleFactor: 0,
    scale: 1,
  };
}
