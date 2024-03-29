'use strict';

var $ = require('bitcore-lib-help').util.preconditions;

var Script = require('bitcore-lib-help').Script;
var Networks = require('bitcore-lib-help').Networks;
var PrivateKey = require('bitcore-lib-help').PrivateKey;
var PublicKey = require('bitcore-lib-help').PublicKey;
var Address = require('bitcore-lib-help').Address;
var _ = require('bitcore-lib-help').deps._;

var Commitment = require('./transactions/commitment');
var Payment = require('./transactions/payment');
var Refund = require('./transactions/refund');

var HOURS_IN_DAY = 24;
var MINUTES_IN_HOUR = 60;
var SECONDS_IN_MINUTE = 60;

var ONE_DAY = SECONDS_IN_MINUTE * MINUTES_IN_HOUR * HOURS_IN_DAY;

/**
 * @param {Object} opts
 * @param {string|Network} opts.network - 'livenet' or 'testnet'
 * @param {number} opts.expires - unix timestamp in millis since epoch
 *
 * @param {bitcore.PrivateKey=} opts.commitmentKey - key to use when negotiating the channel
 *
 * @param {string=} opts.providerPublicKey - the public key for the server, in hexa compressed format
 * @param {string=} opts.providerAddress - the final address where the server will be paid
 *
 * @param {bitcore.PrivateKey=} opts.fundingKey - key to use for funding the channel
 * @param {string=} opts.refundAddress - address to use for refund/change
 * @constructor
 */
function Consumer(opts) {
  /*jshint maxstatements: 30*/
  /*jshint maxcomplexity: 10*/
  opts = opts || {};

  /**
   * @type {bitcore.Network}
   * @desc Either 'livenet' or 'testnet'
   */
  this.network = Networks.get(opts.network || 'livenet');
  /**
   * @type number
   * @desc The expiration date for the channel, in seconds since UNIX epoch
   */
  this.expires = opts.expires || Math.round(new Date().getTime() / 1000) + ONE_DAY;

  /**
   * @type bitcore.PrivateKey
   * @desc This is the key used for the 2-of-2 locking of funds
   */
  this.commitmentKey = new PrivateKey(opts.commitmentKey);

  /**
   * @type {bitcore.PublicKey}
   */
  this.providerPublicKey = new PublicKey(opts.providerPublicKey);

  /**
   * @type {bitcore.Address|string}
   * @desc The address where the server will be paid.
   */
  this.providerAddress = opts.providerAddress ? new Address(opts.providerAddress) : this.providerPublicKey.toAddress();

  /**
   * @type bitcore.PrivateKey
   * @desc A private key for funding the channel. An alternative implementation could
   * provide a list of unspent outputs and the keys needed to sign the outputs
   */
  $.checkArgument(opts.fundingKey instanceof PrivateKey, 'fundingKey is expected to be a PrivateKey');
  this.fundingKey = opts.fundingKey;

  /**
   * @type bitcore.Address
   * @desc The address where the user will pay to fund the channel
   */
  this.fundingAddress = this.fundingKey.toAddress();

  $.checkArgument(opts.refundAddress, 'refundAddress is expected');

  if (opts.refundAddress instanceof Address) {
    /**
     * @type bitcore.Address
     * @desc The address where the refund will go to (also used for the change)
     */
    this.refundAddress = opts.refundAddress;
  } else {
    this.refundAddress = new Address(opts.refundAddress);
  }

  /**
   * @name Consumer#commitmentTx
   * @type Commitment
   * @desc The commitment transaction for this channel
   */
  this.commitmentTx = new Commitment({
    publicKeys: [this.commitmentKey.publicKey, this.providerPublicKey],
    network: this.network
  });
}

/**
 * Adds an UTXO to the funding transaction. The funding transaction exists
 * merely because we can't expect the wallet of the user to support payment
 * channels.
 *
 * @param {Object} utxo
 */
Consumer.prototype.processFunding = function(utxo) {
  $.checkArgument(_.isObject(utxo), 'Can only process an array of objects or an object');
  this.commitmentTx.from(utxo);
};

/**
 * Build the refund transaction (TX 2)
 *
 * @return {bitcore.Transaction}
 */
Consumer.prototype.setupRefund = function() {
  this.commitmentTx.sign(this.fundingKey);
  $.checkState(this.commitmentTx.isFullySigned());
  var amount = this.commitmentTx.amount - this.commitmentTx.getFee();
  var multisigOut = {
    txid: this.commitmentTx.id,
    outputIndex: 0,
    satoshis: amount,
    script: this.commitmentTx.outputs[0].script
  };
  this.refundTx = new Refund()
    .from(multisigOut, this.commitmentTx.publicKeys, 2);
  this.refundTx.to(this.refundAddress, this.refundTx.inputAmount);
  this.refundTx.inputs[0].sequenceNumber = 0;
  this.refundTx.nLockTime = this.expires;
  return this.refundTx;
};

/**
 * Validates that a message contains a valid signature from the Provider
 * that allows the Consumer to spend the lock transaction (TX 1)
 *
 * @param {string} messageFromProvider JSON-serialized message
 * @return {boolean} true if the signature is valid
 */
Consumer.prototype.validateRefund = function(refund) {
  refund = new Refund(refund);
  refund.sign(this.commitmentKey);
  var receivedAddress = new Address(refund.outputs[0].script, this.network).toString();
  $.checkState(receivedAddress === this.refundAddress.toString());
  var amount = refund.outputs[0].satoshis;
  $.checkState(amount === this.commitmentTx.amount - this.commitmentTx.getFee(),
    'Refund amount must equal commitmentTx amount');
  $.checkState(refund.outputs.length === 1, 'More than expected outputs received');
  $.checkState(refund.isFullySigned(), 'Refund was not fully signed');
  $.checkState(Script.Interpreter().verify(
    refund.inputs[0].script,
    refund.inputs[0].output.script,
    refund,
    0,
    Script.Interpreter.SCRIPT_VERIFY_P2SH
    |
    Script.Interpreter.SCRIPT_VERIFY_STRICTENC
    |
    Script.Interpreter.SCRIPT_VERIFY_MINIMALDATA
    |
    Script.Interpreter.SCRIPT_VERIFY_SIGPUSHONLY
  ), 'Refund is incorrectly signed');
  this.refundTx = refund;
  var multisigOut = {
    txid: this.commitmentTx.hash,
    outputIndex: 0,
    satoshis: amount,
    script: this.commitmentTx.outputs[0].script
  };
  this.paymentTx = new Payment({
    multisigOut: multisigOut,
    amount: amount,
    paymentAddress: this.providerAddress,
    changeAddress: this.refundAddress,
    publicKeys: this.commitmentTx.publicKeys,
    network: this.network
  });
  this.paymentTx.sign(this.commitmentKey);
  return true;
};

/**
 * Increments the amount being paid by a given amount of satoshis.
 * @return {bitcore.Transaction} the updated transaction
 */
Consumer.prototype.incrementPaymentBy = function(satoshis) {
  this.paymentTx.updateValue(satoshis);
  this.paymentTx.sign(this.commitmentKey);
  return this.paymentTx.toObject();
};

/**
 * Idiomatic shortcut to retrieve the payment transaction.
 * @return {bitcore.Transaction}
 */
Consumer.prototype.getPaymentTx = function() {
  return this.paymentTx;
};

module.exports = Consumer;
