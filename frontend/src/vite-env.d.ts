/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_IPFS_API_KEY: string
  readonly VITE_IPFS_API_SECRET: string
  readonly VITE_NETWORK: 'testnet' | 'mainnet'
  readonly VITE_FACTORY_CONTRACT_ID: string
  readonly VITE_API_BASE_URL?: string
  readonly VITE_GOVERNANCE_DOCS_URL?: string
  readonly VITE_EXPLORER_PROVIDER?: 'stellar.expert' | 'stellarchain'
  readonly VITE_EXPLORER_BASE_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}