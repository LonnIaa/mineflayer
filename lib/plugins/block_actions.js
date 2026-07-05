const { Vec3 } = require('vec3')

module.exports = inject

const CARDINALS = {
  north: new Vec3(0, 0, -1),
  south: new Vec3(0, 0, 1),
  west: new Vec3(-1, 0, 0),
  east: new Vec3(1, 0, 0)
}

const FACING_MAP = {
  north: { west: 'right', east: 'left' },
  south: { west: 'left', east: 'right' },
  west: { north: 'left', south: 'right' },
  east: { north: 'right', south: 'left' }
}

// Piston BLOCK_ACTION -> bot.pistonEvents feed, for physics engines that model piston pushes.
// Piston facing is the direction's 3D data value (packet byte2); the step vectors follow the
// DOWN 0, UP 1, NORTH 2, SOUTH 3, WEST 4, EAST 5 order, so byte2 is usable as a direction
// ordinal directly.
const PISTON_FACE_STEP = [
  [0, -1, 0], // 0 DOWN
  [0, 1, 0], //  1 UP
  [0, 0, -1], // 2 NORTH
  [0, 0, 1], //  3 SOUTH
  [-1, 0, 0], // 4 WEST
  [1, 0, 0] //   5 EAST
]
// The source piston head/base occupies its own cell; a full-cube moved shape is used as the
// extrusion volume. Precise piston-head platform+shaft geometry and pushed-block / slime-launch /
// honey-drag resolution would require a full piston structure resolver.
const PISTON_MOVED_SHAPE = [[0, 0, 0, 1, 1, 1]]
const PISTON_TICKS_TO_EXTEND = 2 // vanilla pistons take 2 ticks to extend
const PISTON_PROGRESS_STEP = 1 / PISTON_TICKS_TO_EXTEND // progress += 0.5 per tick

function inject (bot) {
  const { instruments, blocks } = bot.registry

  // Stores how many players have currently open a container at a certain position
  const openCountByPos = {}

  // Active moving-piston block entities (the source piston head/base) currently animating.
  // A physics engine can read bot.pistonEvents at the START of each simulate tick and apply the
  // vanilla per-tick extrusion / slime-launch / honey drag. Absent a consumer this feed is a
  // no-op. progress runs 0 -> 0.5 -> pruned over the 2 push ticks; the array reference is shared
  // with the consumer (read-only snapshot input).
  const activePistons = []
  bot.pistonEvents = activePistons

  // Piston block-action trigger: byte1 (b0) is the trigger id (EXTEND=0, CONTRACT=1, DROP=2);
  // byte2 (b1) is the direction's 3D data value. The vanilla client builds ONE source
  // moving-piston block entity: on EXTEND at the arm cell base+facing (the extending head); on
  // CONTRACT/DROP at the base cell itself (the retracting head pulled back into the base). The
  // base-cell (retract-source) case is what lets a physics engine pull an entity out of the
  // piston base, so its x/y/z MUST be the base pos.
  function recordPistonMoveEvent (packet) {
    const direction = packet.byte2
    const step = PISTON_FACE_STEP[direction]
    if (!step) return // not a valid piston facing (0..5) — ignore defensively
    const extending = packet.byte1 === 0 // TRIGGER_EXTEND; CONTRACT(1)/DROP(2) => retracting
    const base = packet.location
    activePistons.push({
      x: extending ? base.x + step[0] : base.x,
      y: extending ? base.y + step[1] : base.y,
      z: extending ? base.z + step[2] : base.z,
      direction,
      extending,
      isSourcePiston: true,
      progress: 0,
      movedShapes: PISTON_MOVED_SHAPE,
      isSlime: false,
      isHoney: false
    })
  }

  // Advance the moving-piston animation each physics tick, POST-simulate (physics.js emits 'physicsTick'
  // synchronously right after simulatePlayer, so this can't race the engine's tick-start read). Matches
  // PistonMovingBlockEntity.tick: progress += 0.5F; once progress reaches 1.0 the block entity stops moving
  // entities (progressO >= 1.0F, :310) so it is dropped from the active snapshot.
  bot.on('physicsTick', () => {
    if (activePistons.length === 0) return
    for (let i = activePistons.length - 1; i >= 0; i--) {
      activePistons[i].progress += PISTON_PROGRESS_STEP
      if (activePistons[i].progress >= 1) activePistons.splice(i, 1)
    }
  })

  function parseChestMetadata (chestBlock) {
    const chestTypes = ['single', 'right', 'left']

    return bot.supportFeature('doesntHaveChestType')
      ? { facing: Object.keys(CARDINALS)[chestBlock.metadata - 2] }
      : {
          waterlogged: !(chestBlock.metadata & 1),
          type: chestTypes[(chestBlock.metadata >> 1) % 3],
          facing: Object.keys(CARDINALS)[Math.floor(chestBlock.metadata / 6)]
        }
  }

  function getChestType (chestBlock) { // Returns 'single', 'right' or 'left'
    if (bot.supportFeature('doesntHaveChestType')) {
      const facing = parseChestMetadata(chestBlock).facing

      if (!facing) return 'single'

      // We have to check if the adjacent blocks in the perpendicular cardinals are the same type
      const perpendicularCardinals = Object.keys(FACING_MAP[facing])
      for (const cardinal of perpendicularCardinals) {
        const cardinalOffset = CARDINALS[cardinal]
        if (bot.blockAt(chestBlock.position.plus(cardinalOffset))?.type === chestBlock.type) {
          return FACING_MAP[cardinal][facing]
        }
      }

      return 'single'
    } else {
      return parseChestMetadata(chestBlock).type
    }
  }

  bot._client.on('block_action', (packet) => {
    const pt = new Vec3(packet.location.x, packet.location.y, packet.location.z)
    const block = bot.blockAt(pt)

    // Ignore on non-vanilla blocks
    if (block === null || !blocks[packet.blockId]) { return }

    const blockName = blocks[packet.blockId].name

    if (blockName === 'noteblock') { // Pre 1.13
      bot.emit('noteHeard', block, instruments[packet.byte1], packet.byte2)
    } else if (blockName === 'note_block') { // 1.13 onward
      bot.emit('noteHeard', block, instruments[Math.floor(block.metadata / 50)], Math.floor((block.metadata % 50) / 2))
    } else if (blockName === 'sticky_piston' || blockName === 'piston') {
      bot.emit('pistonMove', block, packet.byte1, packet.byte2)
      recordPistonMoveEvent(packet) // feed bot.pistonEvents for piston-push physics consumers
    } else {
      let block2 = null

      if (blockName === 'chest' || blockName === 'trapped_chest') {
        const chestType = getChestType(block)
        if (chestType === 'right') {
          const index = Object.values(FACING_MAP[parseChestMetadata(block).facing]).indexOf('left')
          const cardinalBlock2 = Object.keys(FACING_MAP[parseChestMetadata(block).facing])[index]
          const block2Position = block.position.plus(CARDINALS[cardinalBlock2])
          block2 = bot.blockAt(block2Position)
        } else if (chestType === 'left') return // Omit left part of the chest so 'chestLidMove' doesn't emit twice when it's a double chest
      }

      // Emit 'chestLidMove' only if the number of players with the lid open changes
      if (openCountByPos[block.position] !== packet.byte2) {
        bot.emit('chestLidMove', block, packet.byte2, block2)

        if (packet.byte2 > 0) {
          openCountByPos[block.position] = packet.byte2
        } else {
          delete openCountByPos[block.position]
        }
      }
    }
  })

  bot._client.on('block_break_animation', (packet) => {
    const destroyStage = packet.destroyStage
    const pt = new Vec3(packet.location.x, packet.location.y, packet.location.z)
    const block = bot.blockAt(pt)
    const entity = bot.entities[packet.entityId]

    if (destroyStage < 0 || destroyStage > 9) {
      // http://minecraft.wiki/w/Protocol#Block_Break_Progress
      // "0-9 to set it, any other value to remove it"
      bot.emit('blockBreakProgressEnd', block, entity)
    } else {
      bot.emit('blockBreakProgressObserved', block, destroyStage, entity)
    }
  })
}
