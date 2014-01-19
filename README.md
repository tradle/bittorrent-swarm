# bittorrent-swarm

a peer swarm implementation

## install

`npm install bittorrent-swarm`

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