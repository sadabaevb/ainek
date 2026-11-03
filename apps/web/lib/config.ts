// Public, non-secret configuration the browser needs. Read once on the server (config.server.ts) from the root
// .env and handed to the client through <Providers>; pages call useConfig(). No NEXT_PUBLIC_* inlining needed.
export interface PublicConfig {
  model: string;
  incognitoModel: string;
  network: 'testnet' | 'mainnet';
  rpcUrl: string;
  contract: string;
  /** "sample" = docs/samples/key-entry.sample.json until the contract is deployed; "contract" = view calls. */
  logSource: 'sample' | 'contract';
  trustedVerifiers: string[];
  quorum: number;
  explorer: string;
}
