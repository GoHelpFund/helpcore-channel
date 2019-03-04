'use strict';

var inherits = require('inherits');

var Transaction = require('bitcore-lib-help').Transaction;

/**
 * @constructor
 */
function Refund() {
  Transaction.apply(this, arguments);
}
inherits(Refund, Transaction);

module.exports = Refund;
