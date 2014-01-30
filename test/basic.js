var hat = require('hat')
var portfinder = require('portfinder')
var Swarm = require('../')
var test = require('tape')

var infoHash = 'd2474e86c95b19b8bcfdb92bc12c9d44667cfa36'
var peerId1 = '-WW0001-' + hat(48)
var peerId2 = '-WW0001-' + hat(48)

test('create swarm, check invariants', function (t) {
  var swarm = new Swarm(infoHash, peerId1)

  t.equal(swarm.infoHash.toString('hex'), infoHash)
  t.equal(swarm.peerId.toString('utf8'), peerId1)
  t.equal(swarm.downloaded, 0)
  t.equal(swarm.uploaded, 0)
  t.ok(Array.isArray(swarm.wires))
  t.equal(swarm.wires.length, 0)
  t.end()
})

