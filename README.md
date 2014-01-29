# bittorrent-swarm
[![Build Status](http://img.shields.io/travis/feross/bittorrent-swarm.svg)](https://travis-ci.org/feross/bittorrent-swarm)
[![NPM Version](http://img.shields.io/npm/v/bittorrent-swarm.svg)](https://npmjs.org/package/bittorrent-swarm)
[![NPM](http://img.shields.io/npm/dm/bittorrent-swarm.svg)](https://npmjs.org/package/bittorrent-swarm)
[![Gittip](http://img.shields.io/gittip/feross.svg)](https://www.gittip.com/feross/)

### Simple, robust, BitTorrent "swarm" implementation

This is a node.js abstraction of a BitTorrent "swarm" and is used by [WebTorrent](https://github.com/feross/WebTorrent).

## install

```
npm install bittorrent-swarm
```

## methods

``` js
var Swarm = require('bittorrent-swarm')

var swarm = new Swarm(myInfoHash, myPeerId)

swarm.on('wire', function(wire) {
	// a relevant wire has appeared, see `bittorrent-protocol` for more info

	wire.on('unchoke', function() {
		// we are now unchoked
	})

	swarm.wires // <- list of all connected wires
});

swarm.add('127.0.0.1:42442') // add a peer
swarm.remove('127.0.0.1:42244') // remove a peer
```

## license

MIT

This was originally forked from [peer-wire-swarm](https://github.com/mafintosh/peer-wire-swarm) which is also MIT licensed.