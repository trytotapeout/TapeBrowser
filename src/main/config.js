// 网络常量。合约地址来自 TapeKit SPEC §3.1（BNB Smart Chain 主网），与 TapeVault 的 config.js 一致。
// 函数选择器 = keccak256(签名) 前 4 字节，test/abi.test.mjs 会逐个重算核对。

export const BSC = Object.freeze({
  chainId: 56,
  chainIdHex: '0x38',
  name: 'BNB Smart Chain',
  factory: '0x68224f668083c29e9800be2a646d42d18cedf7e2',
  opener: '0x021745de2f42a7839d96f2d3634d0294487d81f1',
  registry: '0xd006ffdd5ae313b17729621a00999cd3c71ce5e6',
  multicall3: '0xca11bde05977b3631167028862be2a173976ca11',
});

// 内置公共节点，按顺序轮换；用户可以在设置里换成自己的节点
export const DEFAULT_RPCS = Object.freeze([
  'https://bsc-dataseed.bnbchain.org',
  'https://bsc-dataseed1.bnbchain.org',
  'https://bsc-dataseed2.bnbchain.org',
  'https://bsc-dataseed1.defibit.io',
  'https://bsc-dataseed1.ninicoin.io',
  'https://bsc-rpc.publicnode.com',
]);

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
