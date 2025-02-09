import { checkDefined } from './preconditions/preconditions'
import { RpcUrlMap } from './RpcUrlMap'
import { ChainId, SUPPORTED_CHAINS } from './util/chain'

type Config = {
  rpcUrls: RpcUrlMap
}

// TODO can just hardcode it if it doesn't work
export const buildConfig = (): Config => {
  const rpcUrls = new RpcUrlMap()
  for (const chainId of SUPPORTED_CHAINS) {
    if (chainId === ChainId.MANDALA_DEVNET) {
      rpcUrls.set(ChainId.MANDALA_DEVNET, 'https://mlg2.mandalachain.io')
    } else {
      const url = checkDefined(process.env[`RPC_${chainId}`], `Missing env variable: RPC_${chainId}`)
      rpcUrls.set(chainId, url)
    }
  }

  return {
    rpcUrls,
  }
}

export const CONFIG = buildConfig()
