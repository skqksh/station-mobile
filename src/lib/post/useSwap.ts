import { useState, useEffect, useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { TFunction } from 'i18next'
import { MsgExecuteContract, MsgSwap } from '@terra-money/terra.js'
import { Coin } from '@terra-money/terra.js'
import {
  PostPage,
  SwapUI,
  ConfirmProps,
  BankData,
  Whitelist,
} from '../types'
import {
  User,
  CoinItem as StationCoin,
  Rate,
  Field,
  FormUI,
} from '../types'
import { find, format } from '../utils'
import { gt, gte, lte, times, percent, minus, div } from '../utils'
import { max, floor, isFinite, isInteger } from '../utils'
import { toInput, toAmount, decimalN } from '../utils/format'
import { useConfig } from '../contexts/ConfigContext'
import useForm from '../hooks/useForm'
import useFCD from '../api/useFCD'
import useBank from '../api/useBank'
import fcd from '../api/fcd'
import useTokenBalance from '../cw20/useTokenBalance'
import validateForm from './validateForm'
import usePairs from '../cw20/usePairs'
import {
  getFeeDenomList,
  isAvailable,
  isFeeAvailable,
} from './validateConfirm'
import { getTerraswapURL, simulateTerraswap } from './terraswap'
import * as routeswap from './routeswap'
import { useCalcFee } from './txHelpers'
import useWhitelist from 'lib/cw20/useWhitelist'
import { UTIL } from 'consts'
import BigNumber from 'bignumber.js'

const { findPair, getRouteMessage } = routeswap
const {
  isRouteAvailable,
  isMarketAvailable,
  simulateRoute,
} = routeswap

const assertLimitOrderContracts: Dictionary = {
  mainnet: 'terra1vs9jr7pxuqwct3j29lez3pfetuu8xmq7tk3lzk',
  testnet: 'terra1z3sf42ywpuhxdh78rr5vyqxpaxa0dx657x5trs',
}

type Mode = 'Market' | 'Terraswap' | 'Route'
interface Values {
  mode?: Mode
  slippage: string
  from: string
  to: string
  input: string
}

interface OracleParamsData {
  result: {
    whitelist: TobinTaxItem[]
  }
}

interface TobinTaxItem {
  name: string
  tobin_tax: string
}

export default (user: User, actives: string[]): PostPage<SwapUI> => {
  const { t } = useTranslation()
  const v = validateForm(t)
  const { chain } = useConfig()

  /* ready: balance */
  const bank = useBank(user)
  const cw20TokenBalance = useTokenBalance(user.address)
  const { whitelist, loading: loadingWhitelist } = useWhitelist()

  const { pairs, loading: loadingPairs } = usePairs(
    chain.current.name
  )
  const loadingUI =
    bank.loading ||
    loadingWhitelist ||
    cw20TokenBalance.isLoading ||
    loadingPairs

  // tokens
  const nativeTokensOptions = ['uluna', ...actives].map((denom) => ({
    value: denom,
    children: format.denom(denom),
    balance: find(`${denom}:available`, bank.data?.balance) ?? '0',
    icon: `https://assets.terra.money/icon/60/${format.denom(
      denom
    )}.png`,
  }))

  const cw20TokensList = whitelist
    ? Object.values(whitelist).map(
        ({ token, symbol, icon, decimals }) => ({
          value: token,
          children: symbol,
          balance:
            cw20TokenBalance.list?.find((x) => x.token === token)
              ?.balance ?? '0',
          icon,
          decimals,
        })
      )
    : []

  const tokens = [...nativeTokensOptions, ...cw20TokensList]
  const getBalance = (from: string): string =>
    tokens.find(({ value }) => value === from)?.balance ?? '0'

  /* ready: tooltip */
  const paramsResponse = useFCD<MarketData>({
    url: '/market/parameters',
  })
  const oracleResponse = useFCD<OracleParamsData>({
    url: '/oracle/parameters',
  })
  const { data: params, error: paramsError } = paramsResponse
  const { data: oracle } = oracleResponse

  /* ready: refetch */
  const load = async (): Promise<void> => {
    init()
    await bank.execute()
    await cw20TokenBalance.refetch()
  }

  /* form */
  const validate = ({
    input,
    from,
    slippage,
  }: Values): {
    slippage: string
    from: string
    to: string
    input: string
  } => ({
    slippage: !isInteger(times(slippage, 100))
      ? 'Slippage must be within 2 decimal points'
      : '',
    from: '',
    to: '',
    input: v.input(
      input,
      { max: toInput(getBalance(from), whitelist?.[from]?.decimals) },
      whitelist?.[from]?.decimals
    ),
  })

  const initial = {
    mode: undefined,
    slippage: '1',
    from: '',
    to: '',
    input: '',
  }

  const [submitted, setSubmitted] = useState(false)
  const form = useForm<Values>(initial, validate)
  const { values, setValue, setValues, invalid } = form
  const { getDefaultProps, getDefaultAttrs } = form
  const { mode, slippage, from, to, input } = values
  const amount = toAmount(input, whitelist?.[from]?.decimals)
  const slippagePercent = isFinite(slippage)
    ? div(slippage, 100)
    : '0.01'

  const pair = findPair({ from, to }, pairs)

  type PairParams = { from: string; to: string }
  const getAvailableModes = useCallback(
    ({ from, to }: PairParams): Mode[] => {
      if (from && to) {
        const available = ([] as Mode[])
          .concat(isMarketAvailable({ from, to }) ? 'Market' : [])
          .concat(findPair({ from, to }, pairs) ? 'Terraswap' : [])

        return available.length
          ? available
          : isRouteAvailable({
              from,
              to,
              chain: chain.current.name,
              pairs,
            })
          ? ['Route']
          : []
      }

      return []
    },
    [chain, pairs]
  )

  const availableModes = useMemo(
    () => getAvailableModes({ from, to }),
    [getAvailableModes, from, to]
  )

  const init = (values?: Partial<Values>): void => {
    const defaultValues = {
      mode: undefined,
      slippage: '1',
      from: '',
      to: '',
      input: '',
    }

    setValues({ ...defaultValues, ...values })
    setTradingFeeTerraswap('0')
  }

  /* simulate */
  type SwapParams = { from: string; to: string; amount: string }
  type Simulation = SwapParams & { result: string }
  const [simulationsMarket, setSimulationsMarket] = useState<
    Simulation[]
  >([])
  const [simulationsTerraswap, setSimulationsTerraswap] = useState<
    Simulation[]
  >([])
  const [simulationsRoute, setSimulationsRoute] = useState<
    Simulation[]
  >([])
  const [simulating, setSimulating] = useState(false)
  const [errorMessage, setErrorMessage] = useState<Error>()

  const findSimulations = (mode: Mode): Simulation[] =>
    ({
      Market: simulationsMarket,
      Terraswap: simulationsTerraswap,
      Route: simulationsRoute,
    }[mode])

  const findSimulated = (
    { from, to, amount }: SwapParams,
    mode: Mode
  ): string =>
    findSimulations(mode)?.find(
      (params) =>
        params.from === from &&
        params.to === to &&
        params.amount === amount
    )?.result ?? '0'

  const simulated = mode
    ? findSimulated({ from, to, amount }, mode)
    : '0'

  const minimum_receive = floor(
    times(simulated, minus(1, slippagePercent))
  )

  // simulate: Native
  const [nativePrincipals, setNativePrincipals] = useState<
    Simulation[]
  >([])

  const principal =
    nativePrincipals.find(
      (params) =>
        params.from === from &&
        params.to === to &&
        params.amount === amount
    )?.result ?? '0'

  // simulate: Terraswap
  const [tradingFeeTerraswap, setTradingFeeTerraswap] = useState('0')

  // simulate: Expected price
  const fromDecimal = whitelist?.[from]?.decimals ?? 6
  const toDecimal = whitelist?.[to]?.decimals ?? 6
  const [price, setPrice] = useState('0')
  const expectedPrice = div(amount, simulated)

  // simulate: Max
  const calcFee = useCalcFee()
  const balance = getBalance(from)
  const calculatedMaxAmount = balance
  const maxAmount =
    bank.data?.balance.length === 1 && calcFee
      ? max([
          minus(
            calculatedMaxAmount,
            calcFee.feeFromGas('800000', from)
          ),
          0,
        ])
      : calculatedMaxAmount

  // simulate
  const isTerraswap = !!pair
  const token = isTerraswap ? from : undefined
  const terraswapParams = { pair, token, offer: { amount, from } }

  const routeParams = {
    amount,
    from,
    to,
    chain: chain.current,
    minimum_receive,
  }

  const { execute: executeRoute } = getRouteMessage(routeParams)

  useEffect(() => {
    const simulate = async (): Promise<void> => {
      setErrorMessage(undefined)
      try {
        setSimulating(true)

        let resultMarket = '0'
        let resultTerraswap = '0'

        if (availableModes.includes('Market')) {
          const { swapped, rate } = await simulateMarket({
            ...values,
            amount,
          })

          resultMarket = swapped

          setNativePrincipals([
            ...nativePrincipals,
            { from, to, amount, result: times(amount, rate!) },
          ])

          setSimulationsMarket((ori) => {
            const filtered = ori.filter(
              (x) =>
                x.from !== from || x.to !== to || x.amount !== amount
            )

            return [
              ...filtered,
              { from, to, amount, result: swapped },
            ]
          })
        }

        if (availableModes.includes('Terraswap')) {
          const result = await simulateTerraswap(
            terraswapParams,
            chain.current,
            user.address
          )

          if (result) {
            resultTerraswap = result.return_amount

            setSimulationsTerraswap((ori) => {
              const filtered = ori.filter(
                (x) =>
                  x.from !== from ||
                  x.to !== to ||
                  x.amount !== amount
              )

              return [
                ...filtered,
                { from, to, amount, result: resultTerraswap },
              ]
            })

            setTradingFeeTerraswap(result.commission_amount)
          }
        }

        if (availableModes.includes('Route')) {
          const result = await simulateRoute(routeParams)
          setSimulationsRoute((ori) => {
            const filtered = ori.filter(
              (x) =>
                x.from !== from || x.to !== to || x.amount !== amount
            )

            return [...filtered, { from, to, amount, result }]
          })
        }

        // Set mode after simulation
        const valid = gt(resultMarket, 0) && gt(resultTerraswap, 0)
        const isBothAvailable = [
          'Market',
          'Terraswap',
        ].every((mode) => availableModes.includes(mode as Mode))

        if (valid && isBothAvailable) {
          const isMarketGreater = gte(resultMarket, resultTerraswap)
          const mode = isMarketGreater ? 'Market' : 'Terraswap'
          setValues((values) => ({ ...values, mode }))
        } else if (availableModes.length === 1) {
          setValues((values) => ({
            ...values,
            mode: availableModes[0],
          }))
        }
      } catch (error) {
        setErrorMessage(error.message)
      }

      setSimulating(false)
    }

    if (from && to) {
      from === to ? init({ from }) : gt(amount, 0) && simulate()
    }

    // eslint-disable-next-line
  }, [amount, from, to])

  useEffect(() => {
    const fetchPrice = async (): Promise<void> => {
      const { data } = await fcd.get<Rate[]>(
        `/v1/market/swaprate/${from}`
      )
      const price = data?.find(({ denom }) => denom === to)?.swaprate
      price && setPrice(price)
    }

    UTIL.isNativeDenom(from) && fetchPrice()
    // eslint-disable-next-line
  }, [from, to])

  useEffect(() => {
    init({ from, slippage })
    // eslint-disable-next-line
  }, [from])

  /* render */
  const fields: Field[] = [
    {
      label: '',
      ...getDefaultProps('from'),
      element: 'select',
      attrs: getDefaultAttrs('from'),
      options: [
        {
          value: '',
          children: t('Post:Swap:Select a coin...'),
          disabled: true,
        },
        ...tokens.filter(({ balance }) => gt(balance, 0)),
      ],
    },
    {
      label: '',
      ...getDefaultProps('input'),
      attrs: {
        ...getDefaultAttrs('input'),
        type: 'number',
        placeholder: '0',
      },
      unit: format.denom(from),
    },
    {
      label: '',
      ...getDefaultProps('to'),
      element: 'select',
      attrs: getDefaultAttrs('to'),
      options: [
        {
          value: '',
          children: t('Post:Swap:Select a coin...'),
          disabled: true,
        },
        ...tokens
          .filter(({ value }) => value !== from)
          .filter(
            ({ value }) =>
              getAvailableModes({ from, to: value }).length
          ),
      ],
    },
    {
      label: '',
      element: 'input',
      attrs: {
        id: 'receive',
        value: gt(simulated, 0)
          ? format.amount(simulated, whitelist?.[to]?.decimals)
          : '',
        readOnly: true,
      },
    },
    {
      label: '',
      ...getDefaultProps('mode'),
      element: 'select',
      attrs: getDefaultAttrs('mode'),
      options: availableModes.map((value) => ({
        value,
        children: value,
      })),
    },
  ]

  const slippageField: Field = {
    label: '',
    ...getDefaultProps('slippage'),
    element: 'input',
    attrs: getDefaultAttrs('slippage'),
  }

  const validInput = !invalid && from && to && lte(amount, maxAmount)
  const validSimulation = gt(simulated, '0')
  const calculating = simulating
  const disabled =
    !validInput || !validSimulation || calculating || !!errorMessage

  const [firstActiveDenom] = actives
  const ui: SwapUI = {
    bank: bank?.data,
    pairs,
    mode: mode ?? '',
    message:
      !firstActiveDenom || errorMessage
        ? t('Post:Swap:Swapping is not available at the moment')
        : t('Post:Swap:Select a coin to swap'),
    max: !from
      ? undefined
      : {
          title: t('Post:Swap:Available balance'),
          display: format.display(
            { amount: maxAmount, denom: from },
            whitelist?.[from]?.decimals,
            undefined,
            whitelist
          ),
          attrs: {
            onClick: (): void =>
              setValue(
                'input',
                toInput(maxAmount, whitelist?.[from]?.decimals)
              ),
          },
        },
    expectedPrice: !gt(simulated, 0)
      ? undefined
      : {
          title: 'Expected price',
          text: !(isFinite(expectedPrice) && gt(expectedPrice, 0))
            ? 'Simulating...'
            : gt(expectedPrice, 1)
            ? `1 ${format.denom(to, whitelist)} = ${format.decimal(
                new BigNumber(expectedPrice)
                  .multipliedBy(
                    fromDecimal === toDecimal
                      ? 1
                      : new BigNumber(10).pow(toDecimal - fromDecimal)
                  )
                  .toString()
              )} ${format.denom(from, whitelist)}`
            : `1 ${format.denom(from, whitelist)} = ${format.decimal(
                new BigNumber(1)
                  .dividedBy(expectedPrice)
                  .multipliedBy(
                    fromDecimal === toDecimal
                      ? 1
                      : new BigNumber(10).pow(fromDecimal - toDecimal)
                  )
                  .toString()
              )} ${format.denom(to, whitelist)}`,
        },
    spread:
      !gt(simulated, 0) || !mode
        ? undefined
        : {
            Market: {
              title: t('Post:Swap:Spread'),
              tooltip:
                params &&
                oracle &&
                getContent(
                  {
                    result: params.result,
                    whitelist: oracle.result.whitelist,
                    denom: to,
                  },
                  t
                ),
              value: format.amount(minus(principal, simulated)),
              unit: format.denom(to, whitelist),
            },
            Terraswap: {
              title: 'Trading Fee',
              value: format.amount(
                tradingFeeTerraswap,
                whitelist?.[to]?.decimals
              ),
              unit: format.denom(to, whitelist),
            },
            Route: {
              title: 'Route',
              text: [
                format.denom(from, whitelist),
                'UST',
                format.denom(to, whitelist),
              ].join(' > '),
            },
          }[mode],
    label: { multipleSwap: t('Post:Swap:Swap multiple coins') },
    slippageField,
  }

  const formUI: FormUI = {
    fields,
    disabled,
    title: t('Page:Swap:Swap coins'),
    submitLabel: t('Common:Form:Next'),
    onSubmit: disabled ? undefined : (): void => setSubmitted(true),
  }

  const assertLimitOrderContract =
    assertLimitOrderContracts[chain.current.name]
  const assertLimitOrder = !assertLimitOrderContract
    ? undefined
    : new MsgExecuteContract(user.address, assertLimitOrderContract, {
        assert_limit_order: {
          offer_coin: { denom: from, amount },
          ask_denom: to,
          minimum_receive,
        },
      })

  const swap = new MsgSwap(user.address, new Coin(from, amount), to)

  const terraswap = pair
    ? getTerraswapURL(terraswapParams, chain.current, user.address, {
        belief_price: String(decimalN(expectedPrice, 18)),
        max_spread: slippagePercent,
      })
    : undefined

  const msgs = !mode
    ? []
    : {
        Market: assertLimitOrder ? [assertLimitOrder, swap] : [swap],
        Terraswap: terraswap?.msgs,
        Route: [
          new MsgExecuteContract(
            user.address,
            executeRoute.contract,
            executeRoute.msg,
            executeRoute.coins
          ),
        ],
      }[mode] || []

  const getConfirm = (
    bank: BankData,
    whitelist: Whitelist
  ): ConfirmProps => ({
    msgs,
    contents: [
      {
        name: 'Mode',
        text: mode,
      },
      {
        name: t('Common:Tx:Amount'),
        displays: [
          format.display(
            { amount, denom: from },
            whitelist?.[from]?.decimals,
            undefined,
            whitelist
          ),
        ],
      },
      {
        name: 'Slippage Tolerance',
        text: slippage + '%',
      },
    ]
      .concat({
        name: t('Post:Swap:Receive'),
        displays: [
          format.display(
            { amount: simulated, denom: to },
            whitelist?.[to]?.decimals,
            undefined,
            whitelist
          ),
        ],
      }),
    feeDenom: { list: getFeeDenomList(bank.balance) },
    validate: (fee: StationCoin): boolean =>
      UTIL.isNativeDenom(from)
        ? isAvailable(
            { amount, denom: from, fee },
            bank.balance
          )
        : isFeeAvailable(fee, bank.balance),
    submitLabels: [t('Post:Swap:Swap'), t('Post:Swap:Swapping...')],
    message: '',
    parseResult: ({ logs }): string => {
      if (!logs) return ''

      const { attributes: attributes1 } = logs[0].events[1]

      const { amount: paid } = splitTokenText(
        attributes1.find(
          ({ key }) => key === 'offer' || key === 'offer_amount'
        )?.value
      )

      const { amount: received } = splitTokenText(
        attributes1.find(
          ({ key }) => key === 'swap_coin' || key === 'return_amount'
        )?.value
      )

      const message = t('Post:Swap:Swapped {{coin}} to {{unit}}', {
        coin: format.coin(
          { amount, denom: from },
          whitelist?.[from]?.decimals,
          undefined,
          whitelist
        ),
        unit: format.denom(to, whitelist),
      })

      const executed_price = div(received, paid)
      const slippage =
        mode !== 'Route' && price
          ? max([minus(div(executed_price, price), 1), '0'])
          : ''

      return slippage
        ? `${message} (Slippage: ${percent(slippage)})`
        : message
    },
    warning: t(
      'Post:Swap:Final amount you receive in {{unit}} may vary due to the swap rate changes',
      { unit: format.denom(to, whitelist) }
    ),
  })

  return {
    ui,
    error: bank.error || paramsError || errorMessage,
    load,
    loading: loadingUI,
    submitted,
    form: formUI,
    confirm: bank.data
      ? getConfirm(bank.data, whitelist ?? {})
      : undefined,
  }
}

/* fetch */
interface SimulateParams {
  from: string
  to: string
  amount: string
}

interface SimulateResult {
  swapped: string
  rate?: string
}

export const simulateMarket = async (
  simulateParams: SimulateParams,
  fetchRate = true
): Promise<SimulateResult> => {
  const { from, to, amount } = simulateParams
  const params = { offer_coin: amount + from, ask_denom: to }
  const url = `/market/swap`
  const swapped = await fcd.get<{ result: StationCoin }>(url, {
    params,
  })

  if (fetchRate) {
    const rateList = await fcd.get<Rate[]>(
      `/v1/market/swaprate/${from}`
    )
    const rate = find(`${to}:swaprate`, rateList.data) ?? '0'
    return { swapped: swapped.data.result.amount, rate }
  } else {
    return { swapped: swapped.data.result.amount }
  }
}

interface MarketData {
  result: {
    min_spread: string
  }
}

interface Params {
  result: MarketData['result']
  whitelist: TobinTaxItem[]
  denom: string
}

const getContent = (params: Params, t: TFunction): string => {
  const { result, whitelist, denom } = params
  const { min_spread } = result

  const min = percent(min_spread)
  const minText = `${[
    t('Post:Swap:Luna swap spread'),
    t('Post:Swap:min.'),
  ].join(': ')} ${min}`

  const tobinTax = whitelist?.find((list) => list.name === denom)
    ?.tobin_tax

  const tobinText = `Terra ${t('Post:Swap:tobin tax')}: ${percent(
    tobinTax ?? 0
  )}`

  return [minText, tobinText].join('\n')
}

export const splitTokenText = (
  string = ''
): {
  amount: string
  token: string
} => {
  const [, amount, token] = string.split(/(\d+)(\w+)/)
  return Number(string)
    ? { amount: string, token: '' }
    : { amount, token }
}
