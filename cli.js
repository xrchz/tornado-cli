#!/usr/bin/env node
// Temporary demo client
// Works both in browser and node.js

require('dotenv').config()
const fs = require('fs')
const axios = require('axios')
const assert = require('assert')
const snarkjs = require('snarkjs')
const crypto = require('crypto')
const circomlib = require('circomlib')
const bigInt = snarkjs.bigInt
const merkleTree = require('./lib/MerkleTree')
const Web3 = require('web3')
const buildGroth16 = require('websnark/src/groth16')
const websnarkUtils = require('websnark/src/utils')
const { toWei, fromWei, toBN, BN } = require('web3-utils')
const config = require('./config')
const program = require('commander')
const { GasPriceOracle } = require('gas-price-oracle')

let web3, tornado, mixerContract, tornadoInstance, circuit, proving_key, groth16, erc20, senderAccount, netId
let MERKLE_TREE_HEIGHT, ETH_AMOUNT, TOKEN_AMOUNT, PRIVATE_KEY

/** Whether we are in a browser or node.js */
const inBrowser = typeof window !== 'undefined'
let isLocalRPC = false

/** Generate random number of specified byte length */
const rbigint = (nbytes) => snarkjs.bigInt.leBuff2int(crypto.randomBytes(nbytes))

/** Compute pedersen hash */
const pedersenHash = (data) => circomlib.babyJub.unpackPoint(circomlib.pedersenHash.hash(data))[0]

/** BigNumber to hex string of specified length */
function toHex(number, length = 32) {
  const str = number instanceof Buffer ? number.toString('hex') : bigInt(number).toString(16)
  return '0x' + str.padStart(length * 2, '0')
}

/** Display ETH account balance */
async function printETHBalance({ address, name }) {
  console.log(`${name} ETH balance is`, web3.utils.fromWei(await web3.eth.getBalance(address)))
}

/** Display ERC20 account balance */
async function printERC20Balance({ address, name, tokenAddress }) {
  const erc20ContractJson = require('./build/contracts/ERC20Mock.json')
  erc20 = tokenAddress ? new web3.eth.Contract(erc20ContractJson.abi, tokenAddress) : erc20
  console.log(`${name} Token Balance is`, web3.utils.fromWei(await erc20.methods.balanceOf(address).call()))
}

/**
 * Create deposit object from secret and nullifier
 */
function createDeposit({ nullifier, secret }) {
  const deposit = { nullifier, secret }
  deposit.preimage = Buffer.concat([deposit.nullifier.leInt2Buff(31), deposit.secret.leInt2Buff(31)])
  deposit.commitment = pedersenHash(deposit.preimage)
  deposit.commitmentHex = toHex(deposit.commitment)
  deposit.nullifierHash = pedersenHash(deposit.nullifier.leInt2Buff(31))
  deposit.nullifierHex = toHex(deposit.nullifierHash)
  return deposit
}

/**
 * Make a deposit
 * @param currency Сurrency
 * @param amount Deposit amount
 */
async function deposit({ currency, amount }) {
  const deposit = createDeposit({
    nullifier: rbigint(31),
    secret: rbigint(31)
  })
  const note = toHex(deposit.preimage, 62)
  const noteString = `tornado-${currency}-${amount}-${netId}-${note}`
  console.log(`Your note: ${noteString}`)
  if (currency === 'eth') {
    await printETHBalance({ address: tornado._address, name: 'Tornado' })
    await printETHBalance({ address: senderAccount, name: 'Sender account' })
    const value = isLocalRPC ? ETH_AMOUNT : fromDecimals({ amount, decimals: 18 })
    console.log('Submitting deposit transaction')
    await tornado.methods.deposit(tornadoInstance, toHex(deposit.commitment), []).send({ value, from: senderAccount, gas: 2e6 })
    await printETHBalance({ address: tornado._address, name: 'Tornado' })
    await printETHBalance({ address: senderAccount, name: 'Sender account' })
  } else {
    // a token
    await printERC20Balance({ address: tornado._address, name: 'Tornado' })
    await printERC20Balance({ address: senderAccount, name: 'Sender account' })
    const decimals = isLocalRPC ? 18 : config.deployments[`netId${netId}`][currency].decimals
    const tokenAmount = isLocalRPC ? TOKEN_AMOUNT : fromDecimals({ amount, decimals })
    if (isLocalRPC) {
      console.log('Minting some test tokens to deposit')
      await erc20.methods.mint(senderAccount, tokenAmount).send({ from: senderAccount, gas: 2e6 })
    }

    const allowance = await erc20.methods.allowance(senderAccount, tornado._address).call({ from: senderAccount })
    console.log('Current allowance is', fromWei(allowance))
    if (toBN(allowance).lt(toBN(tokenAmount))) {
      console.log('Approving tokens for deposit')
      await erc20.methods.approve(tornado._address, tokenAmount).send({ from: senderAccount, gas: 1e6 })
    }

    console.log('Submitting deposit transaction')
    await tornado.methods.deposit(toHex(deposit.commitment)).send({ from: senderAccount, gas: 2e6 })
    await printERC20Balance({ address: tornado._address, name: 'Tornado' })
    await printERC20Balance({ address: senderAccount, name: 'Sender account' })
  }

  return noteString
}

/**
 * Generate merkle tree for a deposit.
 * Download deposit events from the tornado, reconstructs merkle tree, finds our deposit leaf
 * in it and generates merkle proof
 * @param deposit Deposit object
 */
async function generateMerkleProof(deposit, amount) {
  let leafIndex = -1
  // Get all deposit events from smart contract and assemble merkle tree from them

  const cachedEvents = loadCachedEvents({ type: 'Deposit', amount })

  const startBlock = cachedEvents.lastBlock

  let rpcEvents = await mixerContract.getPastEvents('Deposit', {
    fromBlock: startBlock,
    toBlock: 'latest'
  })

  rpcEvents = rpcEvents.map(({ blockNumber, transactionHash, returnValues }) => {
    const { commitment, leafIndex, timestamp } = returnValues
    return {
      blockNumber,
      transactionHash,
      commitment,
      leafIndex: Number(leafIndex),
      timestamp
    }
  })

  const events = cachedEvents.events.concat(rpcEvents)
  console.log('events', events.length)

  const leaves = events
    .sort((a, b) => a.leafIndex - b.leafIndex) // Sort events in chronological order
    .map((e) => {
      const index = toBN(e.leafIndex).toNumber()

      if (toBN(e.commitment).eq(toBN(deposit.commitmentHex))) {
        leafIndex = index
      }
      return toBN(e.commitment).toString(10)
    })
  const tree = new merkleTree(MERKLE_TREE_HEIGHT, leaves)

  // Validate that our data is correct
  const root = await tree.root()
  const isValidRoot = await mixerContract.methods.isKnownRoot(toHex(root)).call()
  const isSpent = await mixerContract.methods.isSpent(toHex(deposit.nullifierHash)).call()
  assert(isValidRoot === true, 'Merkle tree is corrupted')
  assert(isSpent === false, 'The note is already spent')
  assert(leafIndex >= 0, 'The deposit is not found in the tree')

  // Compute merkle proof of our commitment
  return tree.path(leafIndex)
}

/**
 * Generate SNARK proof for withdrawal
 * @param deposit Deposit object
 * @param recipient Funds recipient
 * @param relayer Relayer address
 * @param fee Relayer fee
 * @param refund Receive ether for exchanged tokens
 */
async function generateProof({ deposit, amount, recipient, relayerAddress = 0, fee = 0, refund = 0 }) {
  // Compute merkle proof of our commitment
  const { root, path_elements, path_index } = await generateMerkleProof(deposit, amount)

  // Prepare circuit input
  const input = {
    // Public snark inputs
    root: root,
    nullifierHash: deposit.nullifierHash,
    recipient: bigInt(recipient),
    relayer: bigInt(relayerAddress),
    fee: bigInt(fee),
    refund: bigInt(refund),

    // Private snark inputs
    nullifier: deposit.nullifier,
    secret: deposit.secret,
    pathElements: path_elements,
    pathIndices: path_index
  }

  console.log('Generating SNARK proof')
  console.time('Proof time')
  const proofData = await websnarkUtils.genWitnessAndProve(groth16, input, circuit, proving_key)
  const { proof } = websnarkUtils.toSolidityInput(proofData)
  console.timeEnd('Proof time')

  const args = [
    toHex(input.root),
    toHex(input.nullifierHash),
    toHex(input.recipient, 20),
    toHex(input.relayer, 20),
    toHex(input.fee),
    toHex(input.refund)
  ]

  return { proof, args }
}

/**
 * Do an ETH withdrawal
 * @param noteString Note to withdraw
 * @param recipient Recipient address
 */
async function withdraw({ deposit, currency, amount, recipient, relayerURL, refund = '0' }) {
  if (currency === 'eth' && refund !== '0') {
    throw new Error('The ETH purchase is supposted to be 0 for ETH withdrawals')
  }
  refund = toWei(refund)
  if (relayerURL) {
    if (relayerURL.endsWith('.eth')) {
      throw new Error('ENS name resolving is not supported. Please provide DNS name of the relayer. See instuctions in README.md')
    }
    const relayerStatus = await axios.get(relayerURL + '/status')

    const { rewardAccount, netId, ethPrices, tornadoServiceFee } = relayerStatus.data
    assert(netId === (await web3.eth.net.getId()) || netId === '*', 'This relay is for different network')
    console.log('Relay address: ', rewardAccount)

    const gasPrice = await fetchGasPrice()

    const decimals = isLocalRPC ? 18 : config.deployments[`netId${netId}`][currency].decimals
    const fee = calculateFee({
      currency,
      gasPrice,
      amount,
      refund,
      ethPrices,
      relayerServiceFee: tornadoServiceFee,
      decimals
    })
    if (fee.gt(fromDecimals({ amount, decimals }))) {
      throw new Error('Too high refund')
    }

    const { proof, args } = await generateProof({ deposit, amount, recipient, relayerAddress: rewardAccount, fee, refund })

    console.log('Sending withdraw transaction through relay')
    try {
      const response = await axios.post(relayerURL + '/v1/tornadoWithdraw', {
        contract: tornadoInstance,
        proof,
        args
      })

      const { id } = response.data

      const result = await getStatus(id, relayerURL)
      console.log('STATUS', result)
    } catch (e) {
      if (e.response) {
        console.error(e.response.data.error)
      } else {
        console.error(e.message)
      }
    }
  } else {
    // using private key
    const { proof, args } = await generateProof({ deposit, recipient, refund })

    console.log('Submitting withdraw transaction')
    await tornado.methods
      .withdraw(tornadoInstance, proof, ...args)
      .send({ from: senderAccount, value: refund.toString(), gas: 1e6 })
      .on('transactionHash', function (txHash) {
        if (netId === 1 || netId === 42) {
          console.log(`View transaction on etherscan https://${getCurrentNetworkName()}etherscan.io/tx/${txHash}`)
        } else {
          console.log(`The transaction hash is ${txHash}`)
        }
      })
      .on('error', function (e) {
        console.error('on transactionHash error', e.message)
      })
  }
  console.log('Done')
}

function getStatus(id, relayerURL) {
  return new Promise((resolve) => {
    async function getRelayerStatus() {
      const responseStatus = await axios.get(relayerURL + '/v1/jobs/' + id)

      if (responseStatus.status === 200) {
        const { txHash, status, confirmations, failedReason } = responseStatus.data

        console.log(`Current job status ${status}, confirmations: ${confirmations}`)

        if (status === 'FAILED') {
          throw new Error(status + ' failed reason:' + failedReason)
        }

        if (status === 'CONFIRMED') {
          const receipt = await waitForTxReceipt({ txHash })
          console.log(
            `Transaction submitted through the relay. View transaction on etherscan https://${getCurrentNetworkName()}etherscan.io/tx/${txHash}`
          )
          console.log('Transaction mined in block', receipt.blockNumber)
          resolve(status)
        }
      }

      setTimeout(() => {
        getRelayerStatus(id, relayerURL)
      }, 3000)
    }

    getRelayerStatus()
  })
}

function fromDecimals({ amount, decimals }) {
  amount = amount.toString()
  let ether = amount.toString()
  const base = new BN('10').pow(new BN(decimals))
  const baseLength = base.toString(10).length - 1 || 1

  const negative = ether.substring(0, 1) === '-'
  if (negative) {
    ether = ether.substring(1)
  }

  if (ether === '.') {
    throw new Error('[ethjs-unit] while converting number ' + amount + ' to wei, invalid value')
  }

  // Split it into a whole and fractional part
  const comps = ether.split('.')
  if (comps.length > 2) {
    throw new Error('[ethjs-unit] while converting number ' + amount + ' to wei,  too many decimal points')
  }

  let whole = comps[0]
  let fraction = comps[1]

  if (!whole) {
    whole = '0'
  }
  if (!fraction) {
    fraction = '0'
  }
  if (fraction.length > baseLength) {
    throw new Error('[ethjs-unit] while converting number ' + amount + ' to wei, too many decimal places')
  }

  while (fraction.length < baseLength) {
    fraction += '0'
  }

  whole = new BN(whole)
  fraction = new BN(fraction)
  let wei = whole.mul(base).add(fraction)

  if (negative) {
    wei = wei.mul(negative)
  }

  return new BN(wei.toString(10), 10)
}

function toDecimals(value, decimals, fixed) {
  const zero = new BN(0)
  const negative1 = new BN(-1)
  decimals = decimals || 18
  fixed = fixed || 7

  value = new BN(value)
  const negative = value.lt(zero)
  const base = new BN('10').pow(new BN(decimals))
  const baseLength = base.toString(10).length - 1 || 1

  if (negative) {
    value = value.mul(negative1)
  }

  let fraction = value.mod(base).toString(10)
  while (fraction.length < baseLength) {
    fraction = `0${fraction}`
  }
  fraction = fraction.match(/^([0-9]*[1-9]|0)(0*)/)[1]

  const whole = value.div(base).toString(10)
  value = `${whole}${fraction === '0' ? '' : `.${fraction}`}`

  if (negative) {
    value = `-${value}`
  }

  if (fixed) {
    value = value.slice(0, fixed)
  }

  return value
}

function getCurrentNetworkName() {
  switch (netId) {
    case 1:
      return ''
    case 5:
      return 'goerli.'
    case 42:
      return 'kovan.'
  }
}

function gasPrices(value = 80) {
  const tenPercent = (Number(value) * 5) / 100
  const max = Math.max(tenPercent, 3)
  const bumped = Math.floor(Number(value) + max)
  return toHex(toWei(bumped.toString(), 'gwei'))
}

async function fetchGasPrice() {
  try {
    const oracle = new GasPriceOracle()
    const gas = await oracle.gasPrices()

    return gasPrices(gas.fast)
  } catch (err) {
    throw new Error(`Method fetchGasPrice has error ${err.message}`)
  }
}

function calculateFee({ currency, gasPrice, amount, refund, ethPrices, relayerServiceFee, decimals }) {
  const decimalsPoint =
    Math.floor(relayerServiceFee) === Number(relayerServiceFee) ? 0 : relayerServiceFee.toString().split('.')[1].length
  const roundDecimal = 10 ** decimalsPoint
  const total = toBN(fromDecimals({ amount, decimals }))
  const feePercent = total.mul(toBN(relayerServiceFee * roundDecimal)).div(toBN(roundDecimal * 100))
  const expense = toBN(gasPrice).mul(toBN(5e5))
  let desiredFee
  switch (currency) {
    case 'eth': {
      desiredFee = expense.add(feePercent)
      break
    }
    default: {
      desiredFee = expense
        .add(toBN(refund))
        .mul(toBN(10 ** decimals))
        .div(toBN(ethPrices[currency]))
      desiredFee = desiredFee.add(feePercent)
      break
    }
  }
  return desiredFee
}

/**
 * Waits for transaction to be mined
 * @param txHash Hash of transaction
 * @param attempts
 * @param delay
 */
function waitForTxReceipt({ txHash, attempts = 60, delay = 1000 }) {
  return new Promise((resolve, reject) => {
    const checkForTx = async (txHash, retryAttempt = 0) => {
      const result = await web3.eth.getTransactionReceipt(txHash)
      if (!result || !result.blockNumber) {
        if (retryAttempt <= attempts) {
          setTimeout(() => checkForTx(txHash, retryAttempt + 1), delay)
        } else {
          reject(new Error('tx was not mined'))
        }
      } else {
        resolve(result)
      }
    }
    checkForTx(txHash)
  })
}

function loadCachedEvents({ type, amount }) {
  try {
    if (netId !== 1) {
      return {
        events: [],
        lastBlock: 0,
      }
    }

    const module = require(`./cache/${type.toLowerCase()}s_eth_${amount}.json`)

    if (module) {
      const events = module

      return {
        events,
        lastBlock: events[events.length - 1].blockNumber
      }
    }
  } catch (err) {
    throw new Error(`Method loadCachedEvents has error: ${err.message}`)
  }
}

/**
 * Parses Tornado.cash note
 * @param noteString the note
 */
function parseNote(noteString) {
  const noteRegex = /tornado-(?<currency>\w+)-(?<amount>[\d.]+)-(?<netId>\d+)-0x(?<note>[0-9a-fA-F]{124})/g
  const match = noteRegex.exec(noteString)
  if (!match) {
    throw new Error('The note has invalid format')
  }

  const buf = Buffer.from(match.groups.note, 'hex')
  const nullifier = bigInt.leBuff2int(buf.slice(0, 31))
  const secret = bigInt.leBuff2int(buf.slice(31, 62))
  const deposit = createDeposit({ nullifier, secret })
  const netId = Number(match.groups.netId)

  return {
    currency: match.groups.currency,
    amount: match.groups.amount,
    netId,
    deposit
  }
}

async function loadDepositData({ deposit }) {
  try {
    const eventWhenHappened = await mixerContract.getPastEvents('Deposit', {
      filter: {
        commitment: deposit.commitmentHex
      },
      fromBlock: 0,
      toBlock: 'latest'
    })
    if (eventWhenHappened.length === 0) {
      throw new Error('There is no related deposit, the note is invalid')
    }

    const { timestamp } = eventWhenHappened[0].returnValues
    const txHash = eventWhenHappened[0].transactionHash
    const isSpent = await mixerContract.methods.isSpent(deposit.nullifierHex).call()
    const receipt = await web3.eth.getTransactionReceipt(txHash)

    return {
      timestamp,
      txHash,
      isSpent,
      from: receipt.from,
      commitment: deposit.commitmentHex
    }
  } catch (e) {
    console.error('loadDepositData', e)
  }
  return {}
}
async function loadWithdrawalData({ amount, currency, deposit }) {
  try {
    const cachedEvents = loadCachedEvents({ type: 'Withdrawal', amount })

    const startBlock = cachedEvents.lastBlock

    let rpcEvents = await mixerContract.getPastEvents('Withdrawal', {
      fromBlock: startBlock,
      toBlock: 'latest'
    })

    rpcEvents = rpcEvents.map(({ blockNumber, transactionHash, returnValues }) => {
      const { nullifierHash, to, fee } = returnValues
      return {
        blockNumber,
        transactionHash,
        nullifierHash,
        to,
        fee
      }
    })

    const events = cachedEvents.events.concat(rpcEvents)

    const withdrawEvent = events.filter((event) => {
      return event.nullifierHash === deposit.nullifierHex
    })[0]

    const fee = withdrawEvent.fee
    const decimals = config.deployments[`netId${netId}`][currency].decimals
    const withdrawalAmount = toBN(fromDecimals({ amount, decimals })).sub(toBN(fee))
    const { timestamp } = await web3.eth.getBlock(withdrawEvent.blockHash)
    return {
      amount: toDecimals(withdrawalAmount, decimals, 9),
      txHash: withdrawEvent.transactionHash,
      to: withdrawEvent.to,
      timestamp,
      nullifier: deposit.nullifierHex,
      fee: toDecimals(fee, decimals, 9)
    }
  } catch (e) {
    console.error('loadWithdrawalData', e)
  }
}

/**
 * Init web3, contracts, and snark
 */
async function init({ rpc, noteNetId, currency = 'dai', amount = '100' }) {
  let contractJson, mixerJson, erc20ContractJson, erc20tornadoJson, tornadoAddress, tokenAddress
  // TODO do we need this? should it work in browser really?
  if (inBrowser) {
    // Initialize using injected web3 (Metamask)
    // To assemble web version run `npm run browserify`
    web3 = new Web3(window.web3.currentProvider, null, {
      transactionConfirmationBlocks: 1
    })
    contractJson = await (await fetch('build/contracts/TornadoProxy.abi.json')).json()
    mixerJson = await (await fetch('build/contracts/Mixer.abi.json')).json()
    circuit = await (await fetch('build/circuits/tornado.json')).json()
    proving_key = await (await fetch('build/circuits/tornadoProvingKey.bin')).arrayBuffer()
    MERKLE_TREE_HEIGHT = 20
    ETH_AMOUNT = 1e18
    TOKEN_AMOUNT = 1e19
    senderAccount = (await web3.eth.getAccounts())[0]
  } else {
    // Initialize from local node
    web3 = new Web3(rpc, null, { transactionConfirmationBlocks: 1 })
    contractJson = require('./build/contracts/TornadoProxy.abi.json')
    mixerJson = require('./build/contracts/Mixer.abi.json')
    circuit = require('./build/circuits/tornado.json')
    proving_key = fs.readFileSync('build/circuits/tornadoProvingKey.bin').buffer
    MERKLE_TREE_HEIGHT = process.env.MERKLE_TREE_HEIGHT || 20
    ETH_AMOUNT = process.env.ETH_AMOUNT
    TOKEN_AMOUNT = process.env.TOKEN_AMOUNT
    PRIVATE_KEY = process.env.PRIVATE_KEY
    if (PRIVATE_KEY) {
      const account = web3.eth.accounts.privateKeyToAccount('0x' + PRIVATE_KEY)
      web3.eth.accounts.wallet.add('0x' + PRIVATE_KEY)
      web3.eth.defaultAccount = account.address
      senderAccount = account.address
    } else {
      console.log('Warning! PRIVATE_KEY not found. Please provide PRIVATE_KEY in .env file if you deposit')
    }
    erc20ContractJson = require('./build/contracts/ERC20Mock.json')
    erc20tornadoJson = require('./build/contracts/ERC20Tornado.json')
  }
  // groth16 initialises a lot of Promises that will never be resolved, that's why we need to use process.exit to terminate the CLI
  groth16 = await buildGroth16()
  netId = await web3.eth.net.getId()
  if (noteNetId && Number(noteNetId) !== netId) {
    throw new Error('This note is for a different network. Specify the --rpc option explicitly')
  }
  isLocalRPC = netId > 42

  if (isLocalRPC) {
    tornadoAddress = currency === 'eth' ? contractJson.networks[netId].address : erc20tornadoJson.networks[netId].address
    tokenAddress = currency !== 'eth' ? erc20ContractJson.networks[netId].address : null
    senderAccount = (await web3.eth.getAccounts())[0]
  } else {
    try {
      tornadoAddress = config.deployments[`netId${netId}`].proxy
      tornadoInstance = config.deployments[`netId${netId}`][currency].mixerAddress[amount]

      if (!tornadoAddress) {
        throw new Error()
      }
      tokenAddress = config.deployments[`netId${netId}`][currency].tokenAddress
    } catch (e) {
      console.error('There is no such tornado instance, check the currency and amount you provide')
      process.exit(1)
    }
  }
  tornado = new web3.eth.Contract(contractJson, tornadoAddress)
  mixerContract = new web3.eth.Contract(mixerJson, tornadoInstance)
  erc20 = currency !== 'eth' ? new web3.eth.Contract(erc20ContractJson.abi, tokenAddress) : {}
}

async function main() {
  if (inBrowser) {
    const instance = { currency: 'eth', amount: '0.1' }
    await init(instance)
    window.deposit = async () => {
      await deposit(instance)
    }
    window.withdraw = async () => {
      const noteString = prompt('Enter the note to withdraw')
      const recipient = (await web3.eth.getAccounts())[0]

      const { currency, amount, netId, deposit } = parseNote(noteString)
      await init({ noteNetId: netId, currency, amount })
      await withdraw({ deposit, currency, amount, recipient })
    }
  } else {
    program
      .option('-r, --rpc <URL>', 'The RPC, CLI should interact with', 'http://localhost:8545')
      .option('-R, --relayer <URL>', 'Withdraw via relayer')
    program
      .command('deposit <currency> <amount>')
      .description(
        'Submit a deposit of specified currency and amount from default eth account and return the resulting note. The currency is one of (ETH|DAI|cDAI|USDC|cUSDC|USDT). The amount depends on currency, see config.js file or visit https://tornado.cash.'
      )
      .action(async (currency, amount) => {
        currency = currency.toLowerCase()
        await init({ rpc: program.rpc, currency, amount })
        await deposit({ currency, amount })
      })
    program
      .command('withdraw <note> <recipient> [ETH_purchase]')
      .description(
        'Withdraw a note to a recipient account using relayer or specified private key. You can exchange some of your deposit`s tokens to ETH during the withdrawal by specifing ETH_purchase (e.g. 0.01) to pay for gas in future transactions. Also see the --relayer option.'
      )
      .action(async (noteString, recipient, refund) => {
        const { currency, amount, netId, deposit } = parseNote(noteString)
        await init({ rpc: program.rpc, noteNetId: netId, currency, amount })
        await withdraw({
          deposit,
          currency,
          amount,
          recipient,
          refund,
          relayerURL: program.relayer
        })
      })
    program
      .command('balance <address> [token_address]')
      .description('Check ETH and ERC20 balance')
      .action(async (address, tokenAddress) => {
        await init({ rpc: program.rpc })
        await printETHBalance({ address, name: '' })
        if (tokenAddress) {
          await printERC20Balance({ address, name: '', tokenAddress })
        }
      })
    program
      .command('compliance <note>')
      .description(
        'Shows the deposit and withdrawal of the provided note. This might be necessary to show the origin of assets held in your withdrawal address.'
      )
      .action(async (noteString) => {
        const { currency, amount, netId, deposit } = parseNote(noteString)
        await init({ rpc: program.rpc, noteNetId: netId, currency, amount })
        const depositInfo = await loadDepositData({ deposit })
        const depositDate = new Date(depositInfo.timestamp * 1000)
        console.log('\n=============Deposit=================')
        console.log('Deposit     :', amount, currency)
        console.log('Date        :', depositDate.toLocaleDateString(), depositDate.toLocaleTimeString())
        console.log('From        :', `https://${getCurrentNetworkName()}etherscan.io/address/${depositInfo.from}`)
        console.log('Transaction :', `https://${getCurrentNetworkName()}etherscan.io/tx/${depositInfo.txHash}`)
        console.log('Commitment  :', depositInfo.commitment)
        if (deposit.isSpent) {
          console.log('The note was not spent')
        }

        const withdrawInfo = await loadWithdrawalData({
          amount,
          currency,
          deposit
        })
        const withdrawalDate = new Date(withdrawInfo.timestamp * 1000)
        console.log('\n=============Withdrawal==============')
        console.log('Withdrawal  :', withdrawInfo.amount, currency)
        console.log('Relayer Fee :', withdrawInfo.fee, currency)
        console.log('Date        :', withdrawalDate.toLocaleDateString(), withdrawalDate.toLocaleTimeString())
        console.log('To          :', `https://${getCurrentNetworkName()}etherscan.io/address/${withdrawInfo.to}`)
        console.log('Transaction :', `https://${getCurrentNetworkName()}etherscan.io/tx/${withdrawInfo.txHash}`)
        console.log('Nullifier   :', withdrawInfo.nullifier)
      })
    program
      .command('test')
      .description('Perform an automated test. It deposits and withdraws one ETH and one ERC20 note. Uses ganache.')
      .action(async () => {
        console.log('Start performing ETH deposit-withdraw test')
        let currency = 'eth'
        let amount = '0.1'
        await init({ rpc: program.rpc, currency, amount })
        let noteString = await deposit({ currency, amount })
        let parsedNote = parseNote(noteString)
        await withdraw({
          deposit: parsedNote.deposit,
          currency,
          amount,
          recipient: senderAccount,
          relayerURL: program.relayer
        })

        console.log('\nStart performing DAI deposit-withdraw test')
        currency = 'dai'
        amount = '100'
        await init({ rpc: program.rpc, currency, amount })
        noteString = await deposit({ currency, amount })
        parsedNote = parseNote(noteString)
        await withdraw({
          deposit: parsedNote.deposit,
          currency,
          amount,
          recipient: senderAccount,
          refund: '0.02',
          relayerURL: program.relayer
        })
      })
    try {
      await program.parseAsync(process.argv)
      process.exit(0)
    } catch (e) {
      console.log('Error:', e)
      process.exit(1)
    }
  }
}

main()
