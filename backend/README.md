# Backend

## Configuration

Environment variables are validated at startup in `src/config/env.ts`. Each
network (testnet / mainnet) is described by the same set of keys and feature
flags so the two environments cannot silently drift apart.

### Testnet / mainnet parity check

`src/config/parity.ts` compares the configuration shape of the testnet and
mainnet environments and reports any key or feature flag that exists in one
environment but is missing in the other.

```ts
import { validateConfigParity } from './config/parity';

const result = validateConfigParity(testnetConfig, mainnetConfig, {
  allowlist: ['STELLAR_RPC_URL'], // intentional per-environment differences
});

if (!result.inParity) {
  // result.missingInMainnet / result.missingInTestnet list drifted keys
}
```

#### Allowlist

Some keys are intentionally different between environments (for example the
RPC endpoint URL). Add those keys to the `allowlist` option so they are ignored
by the parity check. Only add a key to the allowlist when the difference is
deliberate and documented here; everything else should be kept in parity.

Run the parity tests with:

```
npm test -- config/parity
```
