import {
  CosignedPriorityOrder,
  CosignedV2DutchOrder,
  CosignedV3DutchOrder,
  DutchOrder,
  OrderValidation,
  OrderValidator,
  UniswapXEventWatcher,
  UniswapXOrder,
} from '@uniswap/uniswapx-sdk'
import { metricScope, MetricsLogger, Unit } from 'aws-embedded-metrics'
import { EventBridgeEvent, ScheduledHandler } from 'aws-lambda'
import { DynamoDB } from 'aws-sdk'
import { default as bunyan, default as Logger } from 'bunyan'
import { ethers } from 'ethers'
import { ORDER_STATUS, SettledAmount, UniswapXOrderEntity } from '../entities'
import { getSettledAmounts } from '../handlers/check-order-status/util'
import { parseOrder } from '../handlers/OrderParser'
import { BaseOrdersRepository, QueryResult } from '../repositories/base'
import { LimitOrdersRepository } from '../repositories/limit-orders-repository'
import { ChainId } from '../util/chain'
import { BLOCK_RANGE, CRON_MAX_ATTEMPTS, DYNAMO_BATCH_WRITE_MAX, OLDEST_BLOCK_BY_CHAIN } from '../util/constants'

export const handler: ScheduledHandler = metricScope((metrics) => async (_event: EventBridgeEvent<string, void>) => {
  await main(metrics)
})

/**
 * The Reaper is a cron job that runs daily and checks for any orphaned orders
 * that have been filled, cancelled or expired
 * @param metrics - The metrics logger
 */
async function main(metrics: MetricsLogger) {
  metrics.setNamespace('Uniswap')
  metrics.setDimensions({ Service: 'UniswapXServiceCron' })
  const log: Logger = bunyan.createLogger({
    name: 'DynamoReaperCron',
    serializers: bunyan.stdSerializers,
    level: 'info',
  })
  const repo = LimitOrdersRepository.create(new DynamoDB.DocumentClient())
  const providers = new Map<ChainId, ethers.providers.StaticJsonRpcProvider>()
  // TODO if you need to add chains, uncomment and update config
  // for (const chainIdKey of Object.keys(OLDEST_BLOCK_BY_CHAIN)) {
  //   const chainId = Number(chainIdKey) as keyof typeof OLDEST_BLOCK_BY_CHAIN
  //   const rpcURL = process.env[`RPC_${chainId}`]
  //   const provider = new ethers.providers.StaticJsonRpcProvider(rpcURL, chainId)
  //   providers.set(chainId, provider)
  // }
  for (const chainId of [6025]) {
    const rpcURL = 'https://mlg1.mandalachain.io'
    const provider = new ethers.providers.StaticJsonRpcProvider(rpcURL, chainId)
    providers.set(chainId, provider)
  }
  await cleanupOrphanedOrders(repo, providers, log, metrics)
  log.info('job complete')
}

type OrderUpdate = {
  status: ORDER_STATUS
  txHash?: string
  fillBlock?: number
  settledAmounts?: SettledAmount[]
}

export async function cleanupOrphanedOrders(
  repo: BaseOrdersRepository<UniswapXOrderEntity>,
  providers: Map<ChainId, ethers.providers.StaticJsonRpcProvider>,
  log: Logger,
  metrics?: MetricsLogger
): Promise<void> {
  // for (const chainIdKey of Object.keys(OLDEST_BLOCK_BY_CHAIN)) {

  log.info('initiating cron lambda')

  const chainId = 6025
  const provider = providers.get(chainId)
  if (!provider) {
    const ERR_MSG = `No provider found for chainId ${chainId}`
    log.error(ERR_MSG)
    throw new Error(ERR_MSG)
  }
  log.info('retrieving past orders')
  // get a map of all open orders from the database
  const parsedOrders = await getParsedOrders(repo, chainId)

  log.info('retrieved parsed orders', { parsedOrders })

  const orderUpdates = new Map<string, OrderUpdate>()

  // Look through events to find if any of the orders have been filled
  // for (const orderType of Object.keys(REACTOR_ADDRESS_MAPPING[chainId])) {
  const reactorAddress = `0x1d597279677795266A31eF5E250dB5f97f0BBbf2`
  if (!reactorAddress) return
  const watcher = new UniswapXEventWatcher(provider, reactorAddress)
  const lastProcessedBlock = await provider.getBlockNumber()
  let recentErrors = 0
  const earliestBlock = OLDEST_BLOCK_BY_CHAIN[chainId]
  // TODO: Lookback 1.2 days
  // const msPerDay = 1000 * 60 * 60 * 24 * 1.2
  // const blocksPerDay = msPerDay / BLOCK_TIME_MS_BY_CHAIN[chainId]
  // const earliestBlock = lastProcessedBlock - blocksPerDay

  log.info('last processed block', { lastProcessedBlock })
  log.info('earliest block', { earliestBlock })

  for (let i = lastProcessedBlock; i > earliestBlock; i -= BLOCK_RANGE) {
    let attempts = 0
    while (attempts < CRON_MAX_ATTEMPTS) {
      try {
        log.info(`Getting fill events for blocks ${i - BLOCK_RANGE} to ${i}`)
        const fillEvents = await watcher.getFillEvents(i - BLOCK_RANGE, i)

        log.info('found fill events for order. num found: ', { numFillEvents: fillEvents.length })

        fillEvents.length
          ? log.info('example fill event: ', { fillEventExample: fillEvents[0] })
          : log.info('no fill events')

        recentErrors = Math.max(0, recentErrors - 1)
        await Promise.all(
          fillEvents.map(async (e) => {
            if (parsedOrders.has(e.orderHash)) {
              log.info(`Fill event found for order ${e.orderHash}`)
              // Only get fill info when we know there's a matching event in this
              // range due to additional RPC calls that are required for fill info
              const fillInfo = await watcher.getFillInfo(i - BLOCK_RANGE, i)
              const fillEvent = fillInfo.find((f) => f.orderHash === e.orderHash)
              if (fillEvent) {
                log.info('found fill event matching hash on watcher')
                const [tx, block] = await Promise.all([
                  provider.getTransaction(fillEvent.txHash),
                  provider.getBlock(fillEvent.blockNumber),
                ])

                log.info('found transaction and block', { tx, block })

                const settledAmounts = getSettledAmounts(
                  fillEvent,
                  {
                    timestamp: block.timestamp,
                    gasPrice: tx.gasPrice,
                    maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
                    maxFeePerGas: tx.maxFeePerGas,
                  },
                  parsedOrders.get(e.orderHash)?.order as
                    | DutchOrder
                    | CosignedV2DutchOrder
                    | CosignedV3DutchOrder
                    | CosignedPriorityOrder
                )

                log.info('found settled amounts', { settledAmounts })

                orderUpdates.set(e.orderHash, {
                  status: ORDER_STATUS.FILLED,
                  txHash: fillEvent.txHash,
                  fillBlock: fillEvent.blockNumber,
                  settledAmounts: settledAmounts,
                })
              } else {
                log.info('no additional metadata found, setting status filled')
                orderUpdates.set(e.orderHash, {
                  status: ORDER_STATUS.FILLED,
                })
              }
            }
          })
        )

        break // Success - exit the retry loop
      } catch (error) {
        attempts++
        recentErrors++
        console.log(`Failed to get fill events for blocks ${i - BLOCK_RANGE} to ${i}, error: ${error}`)
        log.error({ error }, `Failed to get fill events for blocks ${i - BLOCK_RANGE} to ${i}`)
        if (attempts === CRON_MAX_ATTEMPTS) {
          log.error(
            { error },
            `Failed to get fill events after ${attempts} attempts for blocks ${i - BLOCK_RANGE} to ${i}`
          )
          metrics?.putMetric(`GetFillEventsError`, 1, Unit.Count)
          break // Skip this range and continue with the next one
        }
        // Wait time is determined by the number of recent errors
        await new Promise((resolve) => setTimeout(resolve, 1000 * recentErrors))
      }
    }
  }
  // }

  // Loop through unfilled orders and see if they were cancelled
  const quoter = new OrderValidator(provider, chainId, '0xb27d921c5d3D447069C3A7d5d38c6aD5D1ebdd10')
  for (const orderHash of parsedOrders.keys()) {
    log.info('validating order:', { orderHash })
    if (!orderUpdates.has(orderHash)) {
      const validation = await quoter.validate({
        order: parsedOrders.get(orderHash)!.order,
        signature: parsedOrders.get(orderHash)!.signature,
      })
      if (validation === OrderValidation.NonceUsed) {
        orderUpdates.set(orderHash, {
          status: ORDER_STATUS.CANCELLED,
        })
      }
      if (validation === OrderValidation.Expired) {
        orderUpdates.set(orderHash, {
          status: ORDER_STATUS.EXPIRED,
        })
      }
    }
  }

  // Update the orders in the database
  log.info(`Updating ${orderUpdates.size} incorrect orders`)
  for (const [orderHash, orderUpdate] of orderUpdates) {
    log.info('Updating db for order', { orderHash, orderUpdate })
    await repo.updateOrderStatus(
      orderHash,
      orderUpdate.status,
      orderUpdate.txHash,
      orderUpdate.fillBlock,
      orderUpdate.settledAmounts
    )

    metrics?.putMetric(`UpdateOrderStatus_${orderUpdate.status}`, 1, Unit.Count)
  }
  log.info(`Update complete`)
  // }
}

/**
 * Get all open orders from the database and parse them
 * @param repo - The orders repository
 * @param chainId - The chain ID
 * @returns A map of order hashes to their parsed order data
 */
async function getParsedOrders(repo: BaseOrdersRepository<UniswapXOrderEntity>, chainId: ChainId) {
  // Collect all open orders
  let cursor: string | undefined = undefined
  let allOrders: UniswapXOrderEntity[] = []
  do {
    const openOrders: QueryResult<UniswapXOrderEntity> = await repo.getOrders(
      DYNAMO_BATCH_WRITE_MAX,
      {
        orderStatus: ORDER_STATUS.OPEN,
        chainId: chainId,
      },
      cursor
    )
    cursor = openOrders.cursor
    allOrders = allOrders.concat(openOrders.orders)
  } while (cursor)
  const parsedOrders = new Map<string, { order: UniswapXOrder; signature: string; deadline: number }>()
  allOrders.forEach((o) =>
    parsedOrders.set(o.orderHash, { order: parseOrder(o, chainId), signature: o.signature, deadline: o.deadline })
  )
  return parsedOrders
}
