// 网络常量。合约地址与内置节点来自 TapeKit 官方客户端（tapekit.org/.tape/kernel/config.js，SPEC §3）。
// 函数选择器 = keccak256(签名) 前 4 字节，test/address.test.mjs 会逐个重算核对。
//
// 多链命名（SPEC §2）：BNB Smart Chain 不带区号（4246.0 = #4246@0），其他链在处理器编号前加区号：
//   X Layer 区号 2：1.2.344 = #1@2.344     Base 区号 3：1.3.5 = #1@3.5
// 区号一经分配不改、不复用；0 和 1 保留不用。

const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';

export const BSC = Object.freeze({
  key: 'bnb',
  area: null,
  chainId: 56,
  chainIdHex: '0x38',
  name: 'BNB Chain',
  currency: 'BNB',
  factory: '0x68224f668083c29e9800be2a646d42d18cedf7e2',
  opener: '0x021745de2f42a7839d96f2d3634d0294487d81f1',
  registry: '0xd006ffdd5ae313b17729621a00999cd3c71ce5e6',
  multicall3: MULTICALL3,
  // 内置公共节点，按顺序轮换；用户可以在设置里换成自己的节点
  rpcs: Object.freeze([
    'https://bsc-dataseed.bnbchain.org',
    'https://bsc-rpc.publicnode.com',
    'https://bsc-mainnet.public.blastapi.io',
    'https://bsc.drpc.org',
    'https://56.rpc.thirdweb.com',
  ]),
  explorer: 'https://bscscan.com',
  // TapeOut 挖矿奖励代币 BEM（8 位精度）；X Layer 上是 LayerZero 跨链版本，Base 上还没有
  bem: '0x5ce033b2bfca3af30b3e8c8457deaf776a8b695a',
});

// X Layer 和 Base：同一份合约源码、同一部署者按同一顺序部署，两条链上地址相同（和 BNB 不同）
const L2 = Object.freeze({
  factory: '0x1f09daefa827f02cbb40967cc91b259763760761',
  opener: '0x536add8f30f03b69f6fbf29d425a816a0dc50106',
  registry: '0xd6efb7adcc9c83dc4924ad56f6a8e4e969b9adb6',
  multicall3: MULTICALL3,
});

export const XLAYER = Object.freeze({
  key: 'xlayer',
  area: 2,
  chainId: 196,
  chainIdHex: '0xc4',
  name: 'X Layer',
  currency: 'OKB',
  ...L2,
  rpcs: Object.freeze([
    'https://rpc.xlayer.tech',
    'https://xlayerrpc.okx.com',
    'https://xlayer.drpc.org',
    'https://196.rpc.thirdweb.com',
  ]),
  explorer: 'https://www.oklink.com/xlayer',
  bem: '0x60e62efa9405d6873c5deabd4e6cc91c25363952',
});

export const BASE = Object.freeze({
  key: 'base',
  area: 3,
  chainId: 8453,
  chainIdHex: '0x2105',
  name: 'Base',
  currency: 'ETH',
  ...L2,
  rpcs: Object.freeze([
    'https://mainnet.base.org',
    'https://base-rpc.publicnode.com',
    'https://base.drpc.org',
    'https://8453.rpc.thirdweb.com',
  ]),
  explorer: 'https://basescan.org',
  bem: null,
});

/** 所有网络，BNB 在最前 */
export const NETWORKS = Object.freeze([BSC, XLAYER, BASE]);
/** 区号 → 网络（null/undefined = BNB）；未分配的区号返回 null */
export function networkByArea(area) {
  if (area === null || area === undefined) return BSC;
  return NETWORKS.find((n) => n.area !== null && n.area === Number(area)) || null;
}
export const networkByKey = (key) => NETWORKS.find((n) => n.key === String(key)) || null;
export const networkByChainId = (id) => NETWORKS.find((n) => n.chainId === Number(id)) || null;
/** 已分配的区号（不含 BNB） */
export const AREAS = Object.freeze(NETWORKS.filter((n) => n.area !== null).map((n) => n.area));

// 兼容旧代码：BNB 的内置节点
export const DEFAULT_RPCS = BSC.rpcs;

export const SIG = Object.freeze({
  cpuCount: 'cpuCount()',
  cpuAt: 'cpuAt(uint256)',
  accountOf: 'accountOf(address,uint256)',
  isOpened: 'isOpened(address,uint256)',
  ownerOf: 'ownerOf(uint256)',
  balanceOf: 'balanceOf(address)',
  nextId: 'nextId()',
  fileInfo: 'fileInfo(address,string)',
  aggregate3: 'aggregate3((address,bool,bytes)[])',
  readRange: 'readRange(address,string,uint256,uint256)',
});

export const SEL = Object.freeze({
  cpuCount: '0xa94da8a7',
  cpuAt: '0x4bc7cbbd',
  accountOf: '0x0c1905e5',
  isOpened: '0x8b508494',
  ownerOf: '0x6352211e',
  balanceOf: '0x70a08231',
  nextId: '0x61b8ce8c',
  fileInfo: '0x6c609107',
  aggregate3: '0x82ad56cb',
  readRange: '0x15a4cae2',
});

// SiteRegistry 单文件上限：350 块 × 24,000 字节
export const MAX_FILE_BYTES = 350 * 24000;
// readRange 每段读取字节数（SPEC 建议 96 KB）
export const READ_RANGE = 96000;
// 单次 Multicall 打包的调用数
export const MULTICALL_BATCH = 400;
// 扫描钱包时单个处理器最多扫多少个编号
export const MAX_IDS_PER_CPU = 50000;
