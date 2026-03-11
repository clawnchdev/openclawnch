/**
 * Contract Address Registry --- single source of truth for all protocol addresses.
 *
 * Why this exists:
 * - Protocol upgrades change contract addresses (Aave v3 pools, Uniswap routers, etc.)
 * - Before this file, the same address was hardcoded in 6-12 files each
 * - A protocol upgrade required a find-and-replace across the entire codebase
 *
 * Protocol versions pinned here (as of 2026-03-11):
 * - Aave V3 (Base deployment: March 2024)
 * - Lido V2 (stETH/wstETH)
 * - Rocket Pool Atlas (rETH)
 * - Morpho Blue (Base deployment)
 * - Yearn V3 (Base vaults)
 * - Uniswap Universal Router (Base + Ethereum)
 * - Permit2 (canonical, all chains)
 * - Aerodrome (Base DEX + governance)
 * - Chainlink price feeds (multi-chain)
 *
 * Usage:
 *   import { AAVE, LIDO, TOKENS, getChainlinkFeed } from '../lib/contract-registry.js';
 *   const pool = AAVE.pool;     // 0xA238...
 *   const wstETH = LIDO.wstETH; // chain-aware via LIDO.base.wstETH
 */

// ── Helper type ──────────────────────────────────────────────────────────

type Address = `0x${string}`;

// ── Aave V3 (Base deployment) ────────────────────────────────────────────

export const AAVE = {
  /** Aave V3 Pool (Base) --- core lending/borrowing entry point */
  pool: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5' as Address,
  /** Aave V3 PoolDataProvider (Base) --- read-only reserve/user data */
  poolDataProvider: '0x2d8A3C5677189723C4cB8873CfC9C8976FDF38Ac' as Address,
  /** Aave V3 Oracle (Base) --- asset price oracle */
  oracle: '0x2Cc0Fc26eD4563A5ce5e8bdcFe1A2878676Ae156' as Address,

  /** aToken / debtToken addresses for supported assets on Base */
  aTokens: {
    WETH:  { aToken: '0xD4a0e0b9149BCee3C920d2E00b5dE09138fd8bb7' as Address, debtToken: '0x24e6e0795b3c7c71D965fCc4f371803d1c1DcA1E' as Address },
    USDC:  { aToken: '0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB' as Address, debtToken: '0x59dca05b6c26dbd64b5381374aAaC5CD05644C28' as Address },
    cbETH: { aToken: '0xcf3D55c10DB69f28fD1A75Bd73f3D8A2d9c595ad' as Address, debtToken: '0x1DabC36c04f3C3Fc41Da4385e7Aa38f7684C4A13' as Address },
    USDbC: { aToken: '0x0a1d576f3eFeF75b330424287a95A366e8281D54' as Address, debtToken: '0x7376b2F323dC56fCd4C191B34163ac8a84702DAB' as Address },
  },

  /** Aave Governance V2 (Ethereum mainnet) */
  governance: {
    governor: '0xEC568fffba86c094cf06b22134B23074DFE2252c' as Address,
    token: '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9' as Address,
  },
} as const;

// ── Lido (stETH / wstETH) ───────────────────────────────────────────────

export const LIDO = {
  ethereum: {
    stETH:  '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84' as Address,
    wstETH: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0' as Address,
  },
  base: {
    wstETH: '0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452' as Address,
  },
} as const;

// ── Rocket Pool ──────────────────────────────────────────────────────────

export const ROCKET_POOL = {
  ethereum: {
    rETH:        '0xae78736Cd615f374D3085123A210448E74Fc6393' as Address,
    depositPool: '0xDD3f50F8A6CafbE9b31a427582963f465E745AF8' as Address,
  },
  base: {
    rETH: '0xB6fe221Fe9EeF5aBa221c348bA20A1Bf5e73624c' as Address,
  },
} as const;

// ── Coinbase Wrapped Staked ETH ──────────────────────────────────────────

export const CBETH = {
  ethereum: '0xBe9895146f7AF43049ca1c1AE358B0541Ea49BBf' as Address,
  base:     '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22' as Address,
} as const;

// ── Morpho Blue ──────────────────────────────────────────────────────────

export const MORPHO = {
  /** Morpho Blue core (Base) */
  core: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb' as Address,
  /** MORPHO token (Ethereum) */
  token: '0x58D97B57BB95320F9a05dC918Aef65434969c2B2' as Address,
  /** Morpho claim contract (Ethereum) */
  claimContract: '0x678dDC1d07eaa166E502E4eb00E6752Ec7BFc530' as Address,
} as const;

// ── Yearn V3 Vaults (Base) ───────────────────────────────────────────────

export const YEARN = {
  base: {
    yvUSDC: '0x528D0A9F0F3e2BDD98De14163C5E3CB289F37daF' as Address,
    yvWETH: '0xa0225CBE2feAD5efA5E5d5C7f5291e7e2a6C02E4' as Address,
    yvDAI:  '0x305F25377d0a39091e99B975558b1bdfC3975654' as Address,
  },
} as const;

// ── Uniswap ──────────────────────────────────────────────────────────────

export const UNISWAP = {
  /** Universal Router --- deployed at same address on Base, Ethereum, Arbitrum, OP, Polygon */
  universalRouter: '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD' as Address,
  /** V2 Router (Ethereum only) */
  v2Router: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D' as Address,
  /** V3 Router (Ethereum only) */
  v3Router: '0xE592427A0AEce92De3Edee1F18E0157C05861564' as Address,
  base: {
    /** Universal Router on Base (alternative deployment) */
    universalRouter: '0x198EF79F1F515F02dFE9e3115eD9fC07183f02fC' as Address,
    /** V4 Position Manager on Base */
    v4PositionManager: '0x7C5f5A4bBd8fD63184577525326123B519429bDc' as Address,
  },
  governance: {
    governor: '0x408ED6354d4973f66138C91495F2f2FCbd8724C3' as Address,
    token: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984' as Address,
  },
} as const;

// ── Permit2 ──────────────────────────────────────────────────────────────

/** Canonical Permit2 address --- same on all EVM chains */
export const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as Address;

// ── Aerodrome (Base DEX) ─────────────────────────────────────────────────

export const AERODROME = {
  governor: '0x77758EBdD55270809E96DCfe3CDEBe26d4A0eFb1' as Address,
  token:    '0x940181a94A35A4569E4529A3CDfB74e38FD98631' as Address,
} as const;

// ── ENS ──────────────────────────────────────────────────────────────────

export const ENS = {
  governor: '0x323A76393544d5ecca80cd6ef2A560C6a395b7E3' as Address,
  token:    '0xC18360217D8F7Ab5e7c516566761Ea12Ce7F9D72' as Address,
} as const;

// ── DEX Aggregator Routers ───────────────────────────────────────────────

export const DEX_ROUTERS = {
  /** 0x Exchange Proxy --- Base, Ethereum, Arbitrum, OP, Polygon */
  zeroX: '0xDef1C0ded9bec7F1a1670819833240f027b25EfF' as Address,
  /** 1inch Router v5 --- Base, Ethereum, Arbitrum, Polygon */
  oneInch: '0x1111111254EEB25477B68fb85Ed929f73A960582' as Address,
  /** KyberSwap Router (Base) */
  kyber: '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5' as Address,
  /** Odos Router (Base) */
  odos: '0xCf5540fFFCdC3d510B18bFcA6d2b9987b0772559' as Address,
  /** SushiSwap Router (Ethereum) */
  sushi: '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F' as Address,
} as const;

// ── Well-Known Tokens (multi-chain) ──────────────────────────────────────

export const TOKENS = {
  base: {
    USDC:   '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address,
    WETH:   '0x4200000000000000000000000000000000000006' as Address,
    USDT:   '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2' as Address,
    DAI:    '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb' as Address,
    USDbC:  '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA' as Address,
    CLAWNCH: '0xa1F72459dfA10BAD200Ac160eCd78C6b77a747be' as Address,
  },
  ethereum: {
    USDC:  '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as Address,
    WETH:  '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as Address,
    USDT:  '0xdAC17F958D2ee523a2206206994597C13D831ec7' as Address,
    DAI:   '0x6B175474E89094C44Da98b954EedeAC495271d0F' as Address,
    WBTC:  '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599' as Address,
    LINK:  '0x514910771AF9Ca656af840dff83E8264EcF986CA' as Address,
    UNI:   '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984' as Address,
    AAVE:  '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9' as Address,
  },
  arbitrum: {
    USDC:  '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' as Address,
    WETH:  '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1' as Address,
    USDT:  '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9' as Address,
    ARB:   '0x912CE59144191C1204E64559FE8253a0e49E6548' as Address,
    DAI:   '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1' as Address,
  },
  optimism: {
    USDC:  '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85' as Address,
    WETH:  '0x4200000000000000000000000000000000000006' as Address,
    USDT:  '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58' as Address,
    OP:    '0x4200000000000000000000000000000000000042' as Address,
    DAI:   '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1' as Address,
  },
  polygon: {
    USDC:   '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' as Address,
    WETH:   '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619' as Address,
    USDT:   '0xc2132D05D31c914a87C6611C10748AEb04B58e8F' as Address,
    WMATIC: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270' as Address,
    DAI:    '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063' as Address,
    USDCe:  '0x2791bca1f2de4661ed88a30c99a7a9449aa84174' as Address,
  },
} as const;

// ── Sentinel Addresses ───────────────────────────────────────────────────

/** Common sentinel for native ETH in DeFi protocols (e.g. 0x Exchange, Uniswap) */
export const ETH_SENTINEL = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE' as Address;
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;

// ── Airdrop Claim Contracts ──────────────────────────────────────────────

export const AIRDROPS = {
  eigenlayer: { token: '0xec53bF9167f50cDEB3Ae105f56099aaaB9061F83' as Address, claim: '0x035bdA26Bf4d270CfdBe9b32F3580C76BbDdE1F9' as Address },
  zksync:     { token: '0x5A7d6b2F92C77FAD6CCaBd7EE0624E64907Eaf3E' as Address, claim: '0x66Fd4FC8FA52c9bec2AbA368047A0b27e24ecfe4' as Address },
  layerzero:  { token: '0x6985884C4392D348587B19cb9eAAf157F13271cd' as Address, claim: '0xB09F16F625B363875e39ADa56C03682c4B8C01C9' as Address },
  scroll:     { token: '0xd29687c813D741E2F938F4aC377128810E217b1b' as Address, claim: '0xA6EA2f3299b63c53143c993d2d5E60A69CD139Ed' as Address },
  degen:      { token: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed' as Address, claim: ZERO_ADDRESS },
  morpho:     { token: MORPHO.token, claim: MORPHO.claimContract },
  arbitrum:   { token: '0x912CE59144191C1204E64559FE8253a0e49E6548' as Address, claim: '0x67a24CE4321aB3aF51c2D0a4801c3E111D88C9d9' as Address },
  optimism:   { token: '0x4200000000000000000000000000000000000042' as Address, claim: '0xFeDFAF1A10335448b7FA0268F56D2B44DBD357de' as Address },
} as const;

// ── Chainlink Price Feeds ────────────────────────────────────────────────

export const CHAINLINK_FEEDS: Record<number, Record<string, Address>> = {
  // Ethereum mainnet (chain 1)
  1: {
    'ETH/USD':   '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419',
    'BTC/USD':   '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c',
    'LINK/USD':  '0x2c1d072e956AFFC0D435Cb7AC38EF18d24d9127c',
    'UNI/USD':   '0x553303d460EE0afB37EdFf9bE42922D8FF63220e',
    'AAVE/USD':  '0x547a514d5e3769680Ce22B2361c10Ea13619e8a9',
    'COMP/USD':  '0xdbd020CAeF83eFd542f4De03e3cF0C28A4428bd5',
    'MKR/USD':   '0xec1D1B3b0443256cc3860e24a46F108e699484Aa',
    'SNX/USD':   '0xDC3EA94CD0AC27d9A86C180091e7f78C683d3699',
    'CRV/USD':   '0xCd627aA160A6fA45Eb793D19Ef54f5062F20f33f',
    'DAI/USD':   '0xAed0c38402a5d19df6E4c03F4E2DceD6e29c1ee9',
    'USDC/USD':  '0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6',
    'USDT/USD':  '0x3E7d1eAB13ad0104d2750B8863b489D65364e32D',
    'MATIC/USD': '0x7bAC85A8a13A4BcD8abb3eB7d6b4d632c5a57676',
    'ARB/USD':   '0x31697852a68433DbCc2Ff9bA924722580E9730ca',
    'OP/USD':    '0x0D276FC14719f9292D5C1eA2198673d1f4269246',
    'LDO/USD':   '0x4e844125952D32AcdF339BE976c98E22F6F318dB',
    'RPL/USD':   '0x4E155eD98aFE9034b7A5962f6C84c86d869daA9d',
    'DOGE/USD':  '0x2465CefD3b488BE410b941b1d4b2767088e2A028',
    'SHIB/USD':  '0x8dD1CD88F43aF196ae478e91b9F5E4Ac69A97C61',
    'PEPE/USD':  '0x02DE3B1C4534eb56879602Fa89d04E457a4c7f48',
  },
  // Base (chain 8453)
  8453: {
    'ETH/USD':   '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70',
    'BTC/USD':   '0xCCADC697c55bbB68dc5bCdf8d3CBe83CdD4E071E',
    'LINK/USD':  '0x17CAb8FE31cA45e0aBa8eCA8AEa4ad791d9e3b28',
    'USDC/USD':  '0x7e860098F58bBFC8648a4311b374B1D669a2bc6B',
    'DAI/USD':   '0x591e79239a7d679378eC8c847e5038150364C78F',
    'CBETH/USD': '0xd7818272B9e248357d13057AAb0B417aF31E817d',
  },
  // Arbitrum (chain 42161)
  42161: {
    'ETH/USD':  '0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612',
    'BTC/USD':  '0x6ce185860a4963106506C203335A2910413708e9',
    'LINK/USD': '0x86E53CF1B870786351Da77A57575e79CB55812CB',
    'ARB/USD':  '0xb2A824043730FE05F3DA2efaFa1CBbe83fa548D6',
    'USDC/USD': '0x50834F3163758fcC1Df9973b6e91f0F0F0434aD3',
    'DAI/USD':  '0xc5C8E77B397E531B8EC06BFb0048328B30E9eCfB',
    'UNI/USD':  '0x9C917083fDb403ab5ADbEC26Ee294f6EcAda2720',
  },
  // Optimism (chain 10)
  10: {
    'ETH/USD':  '0x13e3Ee699D1909E989722E753853AE30b17e08c5',
    'BTC/USD':  '0xD702DD976Fb76Fffc2D3963D037dfDae5b04E593',
    'LINK/USD': '0xCc232dcFAAE6354cE191Bd574108c1aD03f86229',
    'OP/USD':   '0x0D276FC14719f9292D5C1eA2198673d1f4269246',
    'USDC/USD': '0x16a9FA2FDa030272Ce99B29CF780dFA30361E0f3',
    'DAI/USD':  '0x8dBa75e83DA73cc766A7e5a0ee71F656BAb470d6',
  },
  // Polygon (chain 137)
  137: {
    'ETH/USD':   '0xF9680D99D6C9589e2a93a78A04A279e509205945',
    'BTC/USD':   '0xc907E116054Ad103354f2D350FD2514433D57F6f',
    'LINK/USD':  '0xd9FFdb71EbE7496cC440152d43986Aae0AB76665',
    'MATIC/USD': '0xAB594600376Ec9fD91F8e8dC0f7edF4aed3DA033',
    'USDC/USD':  '0xfE4A8cc5b5B2366C1B58Bea3858e81843583ee2e',
    'DAI/USD':   '0x4746DeC9e833A82EC7C2C1245845D6B60eBCD0E2',
    'AAVE/USD':  '0x72484B12719E23115761D5DA1646945632979bB6',
  },
};

/**
 * Get the Chainlink feed address for a pair on a given chain.
 * Returns undefined if no feed is registered.
 */
export function getChainlinkFeed(chainId: number, pair: string): Address | undefined {
  return CHAINLINK_FEEDS[chainId]?.[pair];
}
