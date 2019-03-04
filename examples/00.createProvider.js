var channel = require('../');
var bitcore = require('bitcore-lib-help');


var providerKey = new bitcore.PrivateKey(bitcore.Networks.testnet);

console.log('provider key: ' + providerKey.toString());
