const { Vec3 } = require('vec3')
const conv = require('../conversions')
const mojangson = require('mojangson')
// These values are only accurate for versions 1.14 and above (crouch hitbox changes)
// Todo: hitbox sizes for sleeping, swimming/crawling, and flying with elytra
const PLAYER_HEIGHT = 1.8
const CROUCH_HEIGHT = 1.5
const PLAYER_WIDTH = 0.6
const PLAYER_EYEHEIGHT = 1.62
const CROUCH_EYEHEIGHT = 1.27

module.exports = inject

// export constants for reuse
module.exports.PLAYER_HEIGHT = PLAYER_HEIGHT
module.exports.CROUCH_HEIGHT = CROUCH_HEIGHT
module.exports.PLAYER_WIDTH = PLAYER_WIDTH
module.exports.PLAYER_EYEHEIGHT = PLAYER_EYEHEIGHT
module.exports.CROUCH_EYEHEIGHT = CROUCH_EYEHEIGHT

// minecraft-data entity.type categories that correspond to a vanilla LivingEntity subclass.
// Confirmed against minecraft-data 1.21.11 entities.json: these six categories cover EVERY LivingEntity
// (incl. aquatic mobs) -- cod/salmon/ghast/iron_golem/ender_dragon='mob', squid/dolphin/villager='passive',
// axolotl/turtle/frog/cow='animal', bat='ambient', armor_stand/mannequin='living', zombie/guardian='hostile';
// non-living (boat/minecart/painting/item_frame/item/experience_orb/end_crystal)='other', arrows='projectile',
// and the player is 'player'. The 'water_*'/'creature' names are living categories used by OTHER minecraft-data
// versions, kept for forward/backward robustness (all unambiguously living). Used to gate the sprint-attack
// self-slowdown so it fires ONLY for player / non-living targets (matching the vanilla client).
const LIVING_ENTITY_TYPE_CATEGORIES = new Set([
  'mob', 'animal', 'hostile', 'passive', 'ambient', 'living',
  'water_creature', 'water_ambient', 'underground_water_creature', 'creature'
])

const animationEvents = {
  0: 'entitySwingArm',
  1: 'entityHurt',
  2: 'entityWake',
  3: 'entityEat',
  4: 'entityCriticalEffect',
  5: 'entityMagicCriticalEffect'
}

const entityStatusEvents = {
  2: 'entityHurt',
  3: 'entityDead',
  6: 'entityTaming',
  7: 'entityTamed',
  8: 'entityShakingOffWater',
  10: 'entityEatingGrass',
  55: 'entityHandSwap'
}

function inject (bot) {
  const { mobs } = bot.registry
  const Entity = require('prismarine-entity')(bot.version)
  const Item = require('prismarine-item')(bot.version)
  const ChatMessage = require('prismarine-chat')(bot.registry)

  // ONLY 1.17 has this destroy_entity packet which is the same thing as entity_destroy packet except the entity is singular
  // 1.17.1 reverted this change so this is just a simpler fix
  bot._client.on('destroy_entity', (packet) => {
    bot._client.emit('entity_destroy', { entityIds: [packet.entityId] })
  })

  bot.findPlayer = bot.findPlayers = (filter) => {
    const filterFn = (entity) => {
      if (entity.type !== 'player') return false
      if (filter === null) return true
      if (typeof filter === 'object' && filter instanceof RegExp) {
        return entity.username.search(filter) !== -1
      } else if (typeof filter === 'function') {
        return filter(entity)
      } else if (typeof filter === 'string') {
        return entity.username.toLowerCase() === filter.toLowerCase()
      }
      return false
    }
    const resultSet = Object.values(bot.entities)
      .filter(filterFn)

    if (typeof filter === 'string') {
      switch (resultSet.length) {
        case 0:
          return null
        case 1:
          return resultSet[0]
        default:
          return resultSet
      }
    }
    return resultSet
  }

  bot.players = {}
  bot.uuidToUsername = {}
  bot.entities = {}

  bot._playerFromUUID = (uuid) => Object.values(bot.players).find(player => player.uuid === uuid)

  bot.nearestEntity = (match = (entity) => { return true }) => {
    let best = null
    let bestDistance = Number.MAX_VALUE

    for (const entity of Object.values(bot.entities)) {
      if (entity === bot.entity || !match(entity)) {
        continue
      }

      const dist = bot.entity.position.distanceSquared(entity.position)
      if (dist < bestDistance) {
        best = entity
        bestDistance = dist
      }
    }

    return best
  }

  // Reset list of players and entities on login
  bot._client.on('login', (packet) => {
    bot.players = {}
    bot.uuidToUsername = {}
    bot.entities = {}
    // login
    bot.entity = fetchEntity(packet.entityId)
    bot.username = bot._client.username
    bot.entity.username = bot._client.username
    bot.entity.type = 'player'
    bot.entity.name = 'player'
    bot.entity.height = PLAYER_HEIGHT
    bot.entity.width = PLAYER_WIDTH
    bot.entity.eyeHeight = PLAYER_EYEHEIGHT
  })

  // Reset the players/entities tracker on a world switch (respawn / dimension change).
  // Emitted by blocks.js's respawn handler when the dimension/world actually changes, and
  // consumed by entity_physics.js to drop stale prediction contexts. The bot's OWN player
  // entity survives the world swap (same LocalPlayer, network id unchanged), so exclude it
  // from the purge and re-seed it into the fresh tracker -- otherwise removeAllEntities()
  // would emit entityGone for it, mark it isValid=false, and drop it from bot.entities with
  // nothing (no login packet on respawn) to recreate it.
  bot.on('worldSwitch', () => {
    const self = bot.entity
    if (self?.id != null) delete bot.entities[self.id]
    removeAllEntities()
    bot.entities = self?.id != null ? { [self.id]: self } : {}
  })

  const removeAllEntities = () => {
    for (const entity of Object.values(bot.entities ?? {})) {
      bot.emit('entityGone', entity)
      entity.isValid = false
      if (entity.username && bot.players[entity.username]) {
        bot.players[entity.username].entity = null
      }
      delete bot.entities[entity.id]
    }
  }

  bot._client.on('entity_equipment', (packet) => {
    // entity equipment
    const entity = fetchEntity(packet.entityId)
    if (packet.equipments !== undefined) {
      packet.equipments.forEach(equipment => entity.setEquipment(equipment.slot, equipment.item ? Item.fromNotch(equipment.item) : null))
    } else {
      entity.setEquipment(packet.slot, packet.item ? Item.fromNotch(packet.item) : null)
    }
    bot.emit('entityEquip', entity)
  })

  bot._client.on('bed', (packet) => {
    // use bed
    const entity = fetchEntity(packet.entityId)
    entity.position.set(packet.location.x, packet.location.y, packet.location.z)
    bot.emit('entitySleep', entity)
  })

  bot._client.on('animation', (packet) => {
    // animation
    const entity = fetchEntity(packet.entityId)
    const eventName = animationEvents[packet.animation]
    if (eventName) bot.emit(eventName, entity)
  })

  bot.on('entityCrouch', (entity) => {
    entity.eyeHeight = CROUCH_EYEHEIGHT
    entity.height = CROUCH_HEIGHT
  })

  bot.on('entityUncrouch', (entity) => {
    entity.eyeHeight = PLAYER_EYEHEIGHT
    entity.height = PLAYER_HEIGHT
  })

  bot._client.on('collect', (packet) => {
    // collect item
    const collector = fetchEntity(packet.collectorEntityId)
    const collected = fetchEntity(packet.collectedEntityId)
    bot.emit('playerCollect', collector, collected)
  })

  // What is internalId?
  const entityDataByInternalId = Object.fromEntries(bot.registry.entitiesArray.map((e) => [e.internalId, e]))

  function setEntityData (entity, type, entityData) {
    entityData ??= entityDataByInternalId[type]
    if (entityData) {
      entity.type = entityData.type || 'object'
      entity.displayName = entityData.displayName
      entity.entityType = entityData.id
      entity.name = entityData.name
      entity.kind = entityData.category
      entity.height = entityData.height
      entity.width = entityData.width
    } else {
      // unknown entity
      entity.type = 'other'
      entity.entityType = type
      entity.displayName = 'unknown'
      entity.name = 'unknown'
      entity.kind = 'unknown'
    }
  }

  function updateEntityPos (entity, pos) {
    if (bot.supportFeature('fixedPointPosition')) {
      entity.position.set(pos.x / 32, pos.y / 32, pos.z / 32)
    } else if (bot.supportFeature('doublePosition')) {
      entity.position.set(pos.x, pos.y, pos.z)
    }
    entity.yaw = conv.fromNotchianYawByte(pos.yaw)
    entity.pitch = conv.fromNotchianPitchByte(pos.pitch)
  }

  function updateEntityVelocity (entity, velocity, emitEvent = true) {
    entity.velocity.update(velocity)
    if (emitEvent) bot.emit('entityVelocity', entity)
  }

  function updateEntityRelativeMove (entity, packet) {
    if (bot.supportFeature('fixedPointDelta')) {
      const dx = packet.dX / 32
      const dy = packet.dY / 32
      const dz = packet.dZ / 32
      entity.position.translate(dx, dy, dz)
      updateEntityVelocity(entity, new Vec3(dx, dy, dz), false)
    } else if (bot.supportFeature('fixedPointDelta128')) {
      // 26.x: velocity is carried by the entity_velocity (lpVec3) packet, not derived here.
      const dx = packet.dX / (128 * 32)
      const dy = packet.dY / (128 * 32)
      const dz = packet.dZ / (128 * 32)
      entity.position.translate(dx, dy, dz)
    }
  }

  function addNewPlayer (entityId, uuid, pos) {
    const entity = fetchEntity(entityId)
    entity.type = 'player'
    entity.name = 'player'
    entity.username = bot.uuidToUsername[uuid]
    entity.uuid = uuid
    updateEntityPos(entity, pos)
    entity.eyeHeight = PLAYER_EYEHEIGHT
    entity.height = PLAYER_HEIGHT
    entity.width = PLAYER_WIDTH
    if (bot.players[entity.username] !== undefined && !bot.players[entity.username].entity) {
      bot.players[entity.username].entity = entity
    }
    return entity
  }

  function addNewNonPlayer (entityId, uuid, entityType, pos) {
    const entity = fetchEntity(entityId)
    const entityData = bot.registry.entities[entityType]
    setEntityData(entity, entityType, entityData)
    updateEntityPos(entity, pos)
    entity.uuid = uuid
    return entity
  }

  function isFishingBobberEntity (entity) {
    return entity &&
      (
        entity.name === 'fishing_bobber' ||
        entity.name === 'fishing_hook' ||
        entity.entityType === 90
      )
  }

  function getSpawnEntityDataField (packet) {
    if (typeof packet.data === 'number') return packet.data
    if (typeof packet.objectData === 'number') return packet.objectData
    return null
  }

  function setFishingBobberOwnerFromSpawnPacket (entity, packet) {
    if (!isFishingBobberEntity(entity)) return

    const ownerId = getSpawnEntityDataField(packet)
    if (typeof ownerId === 'number' && ownerId > 0) {
      entity.ownerId = ownerId
      entity.owner = fetchEntity(ownerId)
    }
  }

  function updateFishingBobberHookedEntity (entity, packet, namedMetas) {
    if (!isFishingBobberEntity(entity)) return

    let rawHookedIdPlusOne = null

    if (namedMetas) {
      rawHookedIdPlusOne =
        namedMetas.hooked_entity ??
        namedMetas.hooked_entity_id ??
        namedMetas.hookedEntity ??
        namedMetas.hookedEntityId ??
        null
    }

    // FishingHook syncs hooked entity as entityId + 1, or 0 for none.
    // Fallback to the historical raw metadata index when named metadata is unavailable.
    if (rawHookedIdPlusOne == null) {
      const rawEntry = packet.metadata.find(m => m.key === 6)
      rawHookedIdPlusOne = rawEntry?.value ?? null
    }

    if (typeof rawHookedIdPlusOne !== 'number') return

    if (rawHookedIdPlusOne > 0) {
      const hookedId = rawHookedIdPlusOne - 1
      entity.hookedEntityId = hookedId
      entity.hookedEntity = fetchEntity(hookedId)
    } else {
      entity.hookedEntityId = null
      entity.hookedEntity = null
    }
  }

  function applyFishingBobberRetractImpulse (bobber) {
    if (!isFishingBobberEntity(bobber)) return

    const hooked = bobber.hookedEntity
    if (!hooked || hooked.id !== bot.entity?.id) return

    const owner = bobber.owner ?? (bobber.ownerId != null ? bot.entities[bobber.ownerId] : null)
    if (!owner) return

    // Vanilla pullEntity:
    // delta = (ownerPos - bobberPos) * 0.1
    const pull = new Vec3(
      (owner.position.x - bobber.position.x) * 0.1,
      (owner.position.y - bobber.position.y) * 0.1,
      (owner.position.z - bobber.position.z) * 0.1
    )

    updateEntityVelocity(hooked, new Vec3(
      hooked.velocity.x + pull.x,
      hooked.velocity.y + pull.y,
      hooked.velocity.z + pull.z
    ))

    bot.emit('fishingBobberRetract', bobber, owner, hooked, pull)
  }

  bot._client.on('named_entity_spawn', (packet) => {
    // in case player_info packet was not sent before named_entity_spawn : ignore named_entity_spawn (see #213)
    if (packet.playerUUID in bot.uuidToUsername) {
      // spawn named entity
      const entity = addNewPlayer(packet.entityId, packet.playerUUID, packet, packet.metadata)
      entity.dataBlobs = packet.data // this field doesn't appear to be listed on any version
      entity.metadata = parseMetadata(packet.metadata, entity.metadata) // 1.8
      bot.emit('entitySpawn', entity)
    }
  })

  // spawn object/vehicle on versions < 1.19, on versions > 1.19 handles all non-player entities
  // on versions >= 1.20.2, this also handles player entities
  bot._client.on('spawn_entity', (packet) => {
    const entityData = entityDataByInternalId[packet.type]
    const entity = entityData?.type === 'player'
      ? addNewPlayer(packet.entityId, packet.objectUUID, packet)
      : addNewNonPlayer(packet.entityId, packet.objectUUID, packet.type, packet)

    // On 26.x (1.21.9+) ALL non-player entities spawn via spawn_entity carrying velocity as
    // lpVec3 (already decoded to blocks/tick) -> no /8000 scale. Older versions send the same
    // `velocity` field as vec3i16 shorts -> apply fromNotchVelocity (/8000). velocity is present
    // on every version >=1.19, so discriminate by the entityVelocityIsLpVec3 feature (1.21.9+),
    // NOT a null-shape key. Vanilla applies the spawn velocity on add.
    if (packet.velocity != null) {
      const rawVel = new Vec3(packet.velocity.x, packet.velocity.y, packet.velocity.z)
      updateEntityVelocity(entity, bot.supportFeature('entityVelocityIsLpVec3') ? rawVel : conv.fromNotchVelocity(rawVel), false)
    }

    setFishingBobberOwnerFromSpawnPacket(entity, packet)

    bot.emit('entitySpawn', entity)
  })

  // spawn_entity_experience_orb packet was removed in 1.21.5+
  // XP orbs are now handled through the general spawn_entity packet
  bot._client.on('spawn_entity_experience_orb', (packet) => {
    const entity = fetchEntity(packet.entityId)
    entity.type = 'orb'
    entity.name = 'experience_orb'
    entity.width = 0.5
    entity.height = 0.5

    if (bot.supportFeature('fixedPointPosition')) {
      entity.position.set(packet.x / 32, packet.y / 32, packet.z / 32)
    } else if (bot.supportFeature('doublePosition')) {
      entity.position.set(packet.x, packet.y, packet.z)
    }

    entity.count = packet.count
    bot.emit('entitySpawn', entity)
  })

  // This packet is removed since 1.19 and merged into spawn_entity
  bot._client.on('spawn_entity_living', (packet) => {
    // spawn mob
    const entity = fetchEntity(packet.entityId)
    entity.type = 'mob'
    entity.uuid = packet.entityUUID
    const entityData = mobs[packet.type]

    setEntityData(entity, packet.type, entityData)

    if (bot.supportFeature('fixedPointPosition')) {
      entity.position.set(packet.x / 32, packet.y / 32, packet.z / 32)
    } else if (bot.supportFeature('doublePosition')) {
      entity.position.set(packet.x, packet.y, packet.z)
    }

    entity.yaw = conv.fromNotchianYawByte(packet.yaw)
    entity.pitch = conv.fromNotchianPitchByte(packet.pitch)
    entity.headPitch = conv.fromNotchianPitchByte(packet.headPitch)

    // 26.x sends velocity as lpVec3 (already decoded to blocks/tick) -> no /8000 scale.
    // Pre-26.x sends raw shorts (velocityX/Y/Z) -> apply fromNotchVelocity (/8000).
    if (packet.velocity != null) {
      updateEntityVelocity(entity, new Vec3(packet.velocity.x, packet.velocity.y, packet.velocity.z), false)
    } else {
      const notchVel = new Vec3(packet.velocityX, packet.velocityY, packet.velocityZ)
      updateEntityVelocity(entity, conv.fromNotchVelocity(notchVel), false)
    }
    entity.metadata = parseMetadata(packet.metadata, entity.metadata)

    bot.emit('entitySpawn', entity)
  })

  bot._client.on('entity_velocity', (packet) => {
    // entity velocity
    const entity = fetchEntity(packet.entityId)
    // bot.supportFeature('entityVelocityIsLpVec3') is unreliable for 1.8.8; key off the
    // packet shape instead. 26.x lpVec3 is ALREADY decoded to blocks/tick -> do NOT apply
    // the legacy /8000 scale (this is the MUST-PRESERVE 26.2 decode). Pre-26.x uses raw shorts.
    if (packet.velocity != null) {
      updateEntityVelocity(entity, new Vec3(packet.velocity.x, packet.velocity.y, packet.velocity.z))
    } else {
      const notchVel = new Vec3(packet.velocityX, packet.velocityY, packet.velocityZ)
      updateEntityVelocity(entity, conv.fromNotchVelocity(notchVel))
    }
  })

  bot._client.on('entity_destroy', (packet) => {
    // destroy entity
    packet.entityIds.forEach((id) => {
      const entity = fetchEntity(id)
      bot.emit('entityGone', entity)
      entity.isValid = false
      if (entity.username && bot.players[entity.username]) {
        bot.players[entity.username].entity = null
      }
      delete bot.entities[id]
    })
  })

  bot._client.on('rel_entity_move', (packet) => {
    // entity relative move
    const entity = fetchEntity(packet.entityId)
    updateEntityRelativeMove(entity, packet)
    bot.emit('entityVelocity', entity)
    bot.emit('entityMoved', entity)
  })

  bot._client.on('entity_look', (packet) => {
    // entity look
    const entity = fetchEntity(packet.entityId)
    entity.yaw = conv.fromNotchianYawByte(packet.yaw)
    entity.pitch = conv.fromNotchianPitchByte(packet.pitch)
    bot.emit('entityMoved', entity)
  })

  bot._client.on('entity_move_look', (packet) => {
    // entity look and relative move
    const entity = fetchEntity(packet.entityId)
    updateEntityRelativeMove(entity, packet)
    if (packet.yaw != null && packet.pitch != null) {
      entity.yaw = conv.fromNotchianYawByte(packet.yaw)
      entity.pitch = conv.fromNotchianPitchByte(packet.pitch)
    }
    bot.emit('entityVelocity', entity)
    bot.emit('entityMoved', entity)
  })

  bot._client.on('entity_teleport', (packet) => {
    // entity teleport
    const entity = fetchEntity(packet.entityId)
    // Capture the pre-teleport position: 26.2 teleports carry per-axis relative flags
    // (PositionUpdateRelatives) and a set flag means the field is RELATIVE to the current pos.
    const prevPos = entity.position.clone()
    if (bot.supportFeature('fixedPointPosition')) {
      entity.position.set(packet.x / 32, packet.y / 32, packet.z / 32)
    }
    if (bot.supportFeature('doublePosition')) {
      entity.position.set(packet.x, packet.y, packet.z)
    }
    // 26.2 entity teleport: the packet now carries a full position-move-rotation (pos vec3 f64 +
    // deltaMovement vec3 f64 + yRot/xRot f32) plus a relatives flags bitset and onGround. The old
    // schema only had i8 angles and no delta, so a decoder using it under-reads the buffer and
    // corrupts the next packet (an intermittent ridden-vehicle position desync). With the
    // corrected f32-degree + delta schema, read yaw/pitch as DEGREES (not notchian bytes) and
    // consume the delta-movement, matching sync_entity_position below.
    if (packet.dx !== undefined) {
      // 26.2 carries a position-update relatives bitset (packet.flags). Apply per-axis relatives
      // exactly like the vanilla client: a SET flag = the field is relative (add to current
      // pos/vel/rotation), UNSET = absolute. Mirrors the self player-position handler in
      // physics.js. Without this a relative entity teleport is applied as absolute.
      const flags = packet.flags || {}
      const vel = entity.velocity
      const curNotchYaw = conv.toNotchianYaw(entity.yaw)
      const curNotchPitch = conv.toNotchianPitch(entity.pitch)
      const newYaw = (flags.yaw ? curNotchYaw : 0) + packet.yaw
      const newPitch = (flags.pitch ? curNotchPitch : 0) + packet.pitch
      // deltaMovement, with optional ROTATE_DELTA momentum carry (yawDelta flag): rotate the
      // current velocity by the yaw/pitch change (Vec3.xRot then Vec3.yRot) before adding.
      let cvx = vel.x; let cvy = vel.y; let cvz = vel.z
      if (flags.yawDelta) {
        const dPitch = (curNotchPitch - newPitch) * Math.PI / 180
        const dYaw = (curNotchYaw - newYaw) * Math.PI / 180
        const cp = Math.cos(dPitch); const sp = Math.sin(dPitch)
        const ry = cvy * cp + cvz * sp
        const rz1 = cvz * cp - cvy * sp
        cvy = ry; cvz = rz1
        const cy = Math.cos(dYaw); const sy = Math.sin(dYaw)
        const rx = cvx * cy + cvz * sy
        const rz2 = cvz * cy - cvx * sy
        cvx = rx; cvz = rz2
      }
      updateEntityVelocity(entity, new Vec3(
        flags.dx ? cvx + packet.dx : packet.dx,
        flags.dy ? cvy + packet.dy : packet.dy,
        flags.dz ? cvz + packet.dz : packet.dz
      ))
      // Position relatives offset from the pre-teleport position captured above.
      entity.position.set(
        flags.x ? prevPos.x + packet.x : packet.x,
        flags.y ? prevPos.y + packet.y : packet.y,
        flags.z ? prevPos.z + packet.z : packet.z
      )
      entity.yaw = conv.fromNotchianYaw(newYaw)
      entity.pitch = conv.fromNotchianPitch(newPitch)
    } else {
      entity.yaw = conv.fromNotchianYawByte(packet.yaw)
      entity.pitch = conv.fromNotchianPitchByte(packet.pitch)
    }
    bot.emit('entityMoved', entity)
  })

  // 1.21.3 - merges the packets above
  bot._client.on('sync_entity_position', (packet) => {
    const entity = fetchEntity(packet.entityId)
    entity.position.set(packet.x, packet.y, packet.z)
    updateEntityVelocity(entity, new Vec3(packet.dx, packet.dy, packet.dz))
    entity.yaw = packet.yaw
    entity.pitch = packet.pitch
    bot.emit('entityMoved', entity)
  })

  bot._client.on('entity_head_rotation', (packet) => {
    // entity head look
    const entity = fetchEntity(packet.entityId)
    entity.headYaw = conv.fromNotchianYawByte(packet.headYaw)
    bot.emit('entityMoved', entity)
  })

  bot._client.on('entity_status', (packet) => {
    // entity status
    const entity = fetchEntity(packet.entityId)

    if (packet.entityStatus === 31 && isFishingBobberEntity(entity)) {
      applyFishingBobberRetractImpulse(entity)
    }

    const eventName = entityStatusEvents[packet.entityStatus]

    if (eventName === 'entityHandSwap' && entity.equipment) {
      [entity.equipment[0], entity.equipment[1]] = [entity.equipment[1], entity.equipment[0]]
      entity.heldItem = entity.equipment[0] // Update held item like prismarine-entity does upon equipment updates
    }

    if (eventName) bot.emit(eventName, entity)
  })

  bot._client.on('damage_event', (packet) => { // 1.20+
    const entity = bot.entities[packet.entityId]
    const source = bot.entities[packet.sourceCauseId - 1] // damage_event : SourceCauseId : The ID + 1 of the entity responsible for the damage, if present. If not present, the value is 0
    bot.emit('entityHurt', entity, source)
  })

  bot._client.on('attach_entity', (packet) => {
    // attach entity
    const entity = fetchEntity(packet.entityId)
    if (packet.vehicleId === -1) {
      const vehicle = entity.vehicle
      delete entity.vehicle
      bot.emit('entityDetach', entity, vehicle)
    } else {
      entity.vehicle = fetchEntity(packet.vehicleId)
      bot.emit('entityAttach', entity, entity.vehicle)
    }
  })

  bot.fireworkRocketDuration = 0
  bot._activeFireworkId = null   // id of the firework rocket entity currently boosting us (cleared on its despawn)
  // `force` (3rd arg): a LOCAL authoritative state change (the bot started gliding via bot.elytraFly, or the
  // physics tick detected onGround and is ending the glide). Forced changes bypass the speculative-swallow
  // guard. Un-forced false calls come from the server's self entity_metadata echo — on servers that do NOT
  // report the controlling player's own FALL_FLYING (0x80) shared-flag (observed live: self shared_flags
  // echoed as 0x0/0x2, never 0x80), those false echoes must NOT wipe our locally-latched speculative glide,
  // or the engine flaps elytra on/off every tick (live: 27 Simulation setbacks). The latch is cleared only by
  // a forced false (land/local-stop) or the safety timeout in bot.elytraFly.
  function setElytraFlyingState (entity, elytraFlying, force = false) {
    let startedFlying = false
    if (elytraFlying) {
      startedFlying = !entity.fallFlying
      entity.fallFlying = true
      entity.elytraFlying = true
      // When the local glide is started speculatively (force=true sets pending just before this call), keep
      // _pendingElytraFlightConfirmation as-is so the subsequent server false-metadata echoes are swallowed.
      // A server-driven true (real 0x80 confirm, force=false) settles the request and clears pending.
      if (!force) entity._pendingElytraFlightConfirmation = false
    } else {
      // Keep speculative local glide state alive while we are still gliding locally: a transient/false self
      // metadata echo must not wipe local flight. Only a FORCED false (land/local-stop) clears it.
      if (!force && entity.id === bot.entity?.id && entity._pendingElytraFlightConfirmation === true) {
        bot.emit('entityElytraState', entity, false)
        return
      }
      if (entity.fallFlying) {
        entity.fallFlying = false
      }
      entity.elytraFlying = false
      entity._pendingElytraFlightConfirmation = false
    }

    if (entity.id === bot.entity?.id) {
      bot.emit('entityElytraState', entity, elytraFlying)
    }

    if (bot.fireworkRocketDuration !== 0 && entity.id === bot.entity?.id && !elytraFlying) {
      bot.fireworkRocketDuration = 0
      bot._activeFireworkId = null
      knownFireworks.clear()
    }

    if (startedFlying) {
      bot.emit('entityElytraFlew', entity)
    }
  }
  // Keep this hook: our physics.js calls bot._setElytraFlyingState (lines ~189/487).
  bot._setElytraFlyingState = setElytraFlyingState

  const knownFireworks = new Set()
  function handleBotUsedFireworkRocket (fireworkEntityId, fireworkInfo) {
    if (knownFireworks.has(fireworkEntityId)) return
    knownFireworks.add(fireworkEntityId)
    let flightDur = fireworkInfo?.nbtData?.value?.Fireworks?.value?.Flight.value ??
      fireworkInfo?.nbt?.value?.Fireworks?.value?.Flight.value ??
      1
    if (typeof flightDur !== 'number') { flightDur = 1 }
    bot._activeFireworkId = fireworkEntityId
    const baseDuration = 10 * (flightDur + 1)
    const randomDuration = Math.floor(Math.random() * 6) + Math.floor(Math.random() * 7)
    bot.fireworkRocketDuration = baseDuration + randomDuration

    bot.emit('usedFirework', fireworkEntityId)
  }
  bot._handleFireworkRocketUse = handleBotUsedFireworkRocket

  let fireworkEntityName
  if (bot.supportFeature('fireworkNamePlural')) {
    fireworkEntityName = 'fireworks_rocket'
  } else if (bot.supportFeature('fireworkNameSingular')) {
    fireworkEntityName = 'firework_rocket'
  }

  let fireworkMetadataIdx
  let fireworkMetadataIsOpt
  if (bot.supportFeature('fireworkMetadataVarInt7')) {
    fireworkMetadataIdx = 7
    fireworkMetadataIsOpt = false
  } else if (bot.supportFeature('fireworkMetadataOptVarInt8')) {
    fireworkMetadataIdx = 8
    fireworkMetadataIsOpt = true
  } else if (bot.supportFeature('fireworkMetadataOptVarInt9')) {
    fireworkMetadataIdx = 9
    fireworkMetadataIsOpt = true
  }
  const hasFireworkSupport = fireworkEntityName !== undefined && fireworkMetadataIdx !== undefined && fireworkMetadataIsOpt !== undefined

  bot._client.on('entity_metadata', (packet) => {
    // entity metadata
    const entity = fetchEntity(packet.entityId)
    const metadata = parseMetadata(packet.metadata, entity.metadata)
    entity.metadata = metadata

    if (bot.supportFeature('mcDataHasEntityMetadata')) {
      const metadataKeys = bot.registry.entitiesByName[entity.name]?.metadataKeys
      const metas = metadataKeys ? Object.fromEntries(packet.metadata.map(e => [metadataKeys[e.key], e.value])) : {}

      updateFishingBobberHookedEntity(entity, packet, metas)

      bot.emit('entityUpdate', entity)

      if (packet.metadata.some(m => m.type === 'item_stack')) {
        bot.emit('itemDrop', entity)
      }
      if (metas.sleeping_pos || metas.pose === 2) {
        bot.emit('entitySleep', entity)
      }

      if (hasFireworkSupport && fireworkEntityName === entity.name && metas.attached_to_target !== undefined) {
        // fireworkMetadataOptVarInt9 and later is implied by
        // mcDataHasEntityMetadata, so no need to check metadata index and type
        // (eg fireworkMetadataOptVarInt8)
        if (metas.attached_to_target !== 0) {
          const entityId = metas.attached_to_target - 1
          if (entityId === bot.entity?.id) {
            handleBotUsedFireworkRocket(entity.id, metas.fireworks_item)
          }
        }
      }

      if (metas.shared_flags != null) {
        if (bot.supportFeature('hasElytraFlying')) {
          const elytraFlying = metas.shared_flags & 0x80
          setElytraFlyingState(entity, Boolean(elytraFlying))
        }

        if (metas.shared_flags & 2) {
          entity.crouching = true
          bot.emit('entityCrouch', entity)
        } else if (entity.crouching) { // prevent the initial entity_metadata packet from firing off an uncrouch event
          entity.crouching = false
          bot.emit('entityUncrouch', entity)
        }
      }

      // Breathing (formerly in breath.js)
      if (metas.air_supply != null) {
        bot.oxygenLevel = Math.round(metas.air_supply / 15)
        bot.emit('breath')
      }
    } else {
      updateFishingBobberHookedEntity(entity, packet, null)

      bot.emit('entityUpdate', entity)

      const typeSlot = (bot.supportFeature('itemsAreAlsoBlocks') ? 5 : 6) + (bot.supportFeature('entityMetadataHasLong') ? 1 : 0)
      const slot = packet.metadata.find(e => e.type === typeSlot)
      if (entity.name && (entity.name.toLowerCase() === 'item' || entity.name === 'item_stack') && slot) {
        bot.emit('itemDrop', entity)
      }

      const typePose = bot.supportFeature('entityMetadataHasLong') ? 19 : 18
      const pose = packet.metadata.find(e => e.type === typePose)
      if (pose && pose.value === 2) {
        bot.emit('entitySleep', entity)
      }

      if (hasFireworkSupport && fireworkEntityName === entity.name) {
        const attachedToTarget = packet.metadata.find(e => e.key === fireworkMetadataIdx)
        if (attachedToTarget !== undefined) {
          let entityId
          if (fireworkMetadataIsOpt) {
            if (attachedToTarget.value !== 0) {
              entityId = attachedToTarget.value - 1
            } // else, not attached to an entity
          } else {
            entityId = attachedToTarget.value
          }
          if (entityId !== undefined && entityId === bot.entity?.id) {
            const fireworksItem = packet.metadata.find(e => e.key === (fireworkMetadataIdx - 1))
            handleBotUsedFireworkRocket(entity.id, fireworksItem?.value)
          }
        }
      }

      const bitField = packet.metadata.find(p => p.key === 0)
      if (bitField !== undefined) {
        if (bot.supportFeature('hasElytraFlying')) {
          const elytraFlying = bitField.value & 0x80
          setElytraFlyingState(entity, Boolean(elytraFlying))
        }

        if ((bitField.value & 2) !== 0) {
          entity.crouching = true
          bot.emit('entityCrouch', entity)
        } else if (entity.crouching) { // prevent the initial entity_metadata packet from firing off an uncrouch event
          entity.crouching = false
          bot.emit('entityUncrouch', entity)
        }
      }
    }
  })

  bot._client.on('entity_effect', (packet) => {
    // entity effect
    const entity = fetchEntity(packet.entityId)
    const effect = {
      id: packet.effectId,
      amplifier: packet.amplifier,
      duration: packet.duration
    }
    entity.effects[effect.id] = effect
    bot.emit('entityEffect', entity, effect)
  })

  bot._client.on('remove_entity_effect', (packet) => {
    // remove entity effect
    const entity = fetchEntity(packet.entityId)
    let effect = entity.effects[packet.effectId]
    if (effect) {
      delete entity.effects[effect.id]
    } else {
      // unknown effect
      effect = {
        id: packet.effectId,
        amplifier: -1,
        duration: -1
      }
    }
    bot.emit('entityEffectEnd', entity, effect)
  })

  const updateAttributes = (packet) => {
    const entity = fetchEntity(packet.entityId)
    if (!entity.attributes) entity.attributes = {}
    for (const prop of packet.properties) {
      entity.attributes[prop.key ?? prop.name] = {
        value: prop.value,
        modifiers: prop.modifiers
      }
    }
    bot.emit('entityAttributes', entity)
  }
  bot._client.on('update_attributes', updateAttributes) // 1.8
  bot._client.on('entity_update_attributes', updateAttributes) // others

  bot._client.on('spawn_entity_weather', (packet) => {
    // spawn global entity
    const entity = fetchEntity(packet.entityId)
    entity.type = 'global'
    entity.globalType = 'thunderbolt'
    entity.uuid = packet.entityUUID
    entity.position.set(packet.x / 32, packet.y / 32, packet.z / 32)
    bot.emit('entitySpawn', entity)
  })

  bot.on('spawn', () => {
    bot.emit('entitySpawn', bot.entity)
  })

  function handlePlayerInfoBitfield (packet) {
    for (const item of packet.data) {
      let player = bot._playerFromUUID(item.uuid)
      const newPlayer = !player

      if (newPlayer) {
        player = { uuid: item.uuid }
      }

      if (packet.action.add_player) {
        player.username = item.player.name
        player.displayName = new ChatMessage({ text: '', extra: [{ text: item.player.name }] })
        player.skinData = extractSkinInformation(item.player.properties)
      }
      if (packet.action.initialize_chat && item.chatSession) {
        player.chatSession = {
          publicKey: item.chatSession.publicKey,
          sessionUuid: item.chatSession.uuid
        }
      }
      if (packet.action.update_game_mode) {
        player.gamemode = item.gamemode
      }
      if (packet.action.update_listed) {
        player.listed = item.listed
      }
      if (packet.action.update_latency) {
        player.ping = item.latency
      }
      if (packet.action.update_display_name) {
        player.displayName = item.displayName ? ChatMessage.fromNotch(item.displayName) : new ChatMessage({ text: '', extra: [{ text: player.username }] })
      }

      if (newPlayer) {
        if (!player.username) continue // Should be unreachable if add_player is always sent for new players
        bot.players[player.username] = player
        bot.uuidToUsername[player.uuid] = player.username
      }

      const playerEntity = Object.values(bot.entities).find(e => e.type === 'player' && e.username === player.username)
      player.entity = playerEntity

      if (playerEntity === bot.entity) {
        bot.player = player
      }

      if (newPlayer) {
        bot.emit('playerJoined', player)
      } else {
        bot.emit('playerUpdated', player)
      }
    }
  }

  function handlePlayerInfoLegacy (packet) {
    for (const item of packet.data) {
      let player = bot._playerFromUUID(item.uuid)

      switch (packet.action) {
        case 'add_player': {
          const newPlayer = !player
          if (newPlayer) {
            player = bot.players[item.name] = {
              username: item.name,
              uuid: item.uuid
            }
            bot.uuidToUsername[item.uuid] = item.name
          }

          player.ping = item.ping
          player.gamemode = item.gamemode
          player.displayName = item.displayName ? ChatMessage.fromNotch(item.displayName) : new ChatMessage({ text: '', extra: [{ text: item.name }] })
          if (item.properties) {
            player.skinData = extractSkinInformation(item.properties)
          }
          if (item.crypto) {
            player.profileKeys = {
              publicKey: item.crypto.publicKey,
              signature: item.crypto.signature
            }
          }

          const playerEntity = Object.values(bot.entities).find(e => e.type === 'player' && e.username === item.name)
          player.entity = playerEntity
          if (playerEntity === bot.entity) {
            bot.player = player
          }

          if (newPlayer) bot.emit('playerJoined', player)
          else bot.emit('playerUpdated', player)
          break
        }
        case 'update_gamemode': {
          if (player) {
            player.gamemode = item.gamemode
            bot.emit('playerUpdated', player)
          }
          break
        }
        case 'update_latency': {
          if (player) {
            player.ping = item.ping
            bot.emit('playerUpdated', player)
          }
          break
        }
        case 'update_display_name': {
          if (player) {
            player.displayName = item.displayName ? ChatMessage.fromNotch(item.displayName) : new ChatMessage({ text: '', extra: [{ text: player.username }] })
            bot.emit('playerUpdated', player)
          }
          break
        }
        case 'remove_player': {
          if (player) {
            if (player.entity === bot.entity) continue
            player.entity = null
            delete bot.players[player.username]
            delete bot.uuidToUsername[item.uuid]
            bot.emit('playerLeft', player)
          }
          break
        }
      }
    }
  }

  bot._client.on('player_info', bot.supportFeature('playerInfoActionIsBitfield') ? handlePlayerInfoBitfield : handlePlayerInfoLegacy)

  // 1.19.3+ - player(s) leave the game
  bot._client.on('player_remove', (packet) => {
    for (const uuid of packet.players) {
      const player = bot._playerFromUUID(uuid)
      if (!player || player.entity === bot.entity) continue

      player.entity = null
      delete bot.players[player.username]
      delete bot.uuidToUsername[uuid]
      bot.emit('playerLeft', player)
    }
  })

  // attaching to a vehicle
  bot._client.on('attach_entity', (packet) => {
    const passenger = fetchEntity(packet.entityId)
    const vehicle = packet.vehicleId === -1 ? null : fetchEntity(packet.vehicleId)

    const originalVehicle = passenger.vehicle
    if (originalVehicle) {
      const index = originalVehicle.passengers.indexOf(passenger)
      originalVehicle.passengers.splice(index, 1)
    }
    passenger.vehicle = vehicle
    if (vehicle) {
      vehicle.passengers.push(passenger)
    }

    if (packet.entityId === bot.entity.id) {
      const vehicle = bot.vehicle
      if (packet.vehicleId === -1) {
        bot.vehicle = null
        bot.emit('dismount', vehicle)
      } else {
        bot.vehicle = bot.entities[packet.vehicleId]
        bot.emit('mount')
      }
    }
  })

  bot._client.on('set_passengers', ({ entityId, passengers }) => {
    const passengerEntities = passengers.map((passengerId) => fetchEntity(passengerId))
    const vehicle = entityId === -1 ? null : bot.entities[entityId]

    for (const passengerEntity of passengerEntities) {
      const originalVehicle = passengerEntity.vehicle
      if (originalVehicle) {
        const index = originalVehicle.passengers.indexOf(passengerEntity)
        originalVehicle.passengers.splice(index, 1)
      }
      passengerEntity.vehicle = vehicle
      if (vehicle) {
        vehicle.passengers.push(passengerEntity)
      }
    }

    if (passengers.includes(bot.entity.id)) {
      const originalVehicle = bot.vehicle
      if (entityId === -1) {
        bot.vehicle = null
        bot.emit('dismount', originalVehicle)
      } else {
        bot.vehicle = bot.entities[entityId]
        bot.emit('mount')
      }
    } else if (bot.vehicle && bot.vehicle.id === entityId) {
      // EJECT FIX: the bot was a passenger of THIS vehicle but the new passenger list for it no longer
      // includes the bot -> it was ejected (e.g. dismount input accepted, /ride dismount, or a passenger
      // teleport). mineflayer previously only handled the bot being ADDED to a passenger list, so an eject
      // (empty / bot-less list for the bot's current vehicle) left bot.vehicle STALE -> updatePosition kept
      // emitting vehicle_move for a vehicle the server no longer attaches the player to -> setback loop +
      // the player frozen. Detect the removal and fire dismount so bot.vehicle clears + physics resumes.
      const originalVehicle = bot.vehicle
      bot.vehicle = null
      bot.emit('dismount', originalVehicle)
    }
  })

  // dismounting when the vehicle is gone
  bot._client.on('entityGone', (entity) => {
    if (bot.vehicle === entity) {
      bot.vehicle = null
      bot.emit('dismount', (entity))
    }
    if (entity.passengers) {
      for (const passenger of entity.passengers) {
        passenger.vehicle = null
      }
    }
    if (entity.vehicle) {
      const index = entity.vehicle.passengers.indexOf(entity)
      if (index !== -1) {
        entity.vehicle.passengers.splice(index, 1)
      }
    }
  })

  bot.swingArm = swingArm
  bot.attack = attack
  bot.mount = mount
  bot.dismount = dismount
  bot.useOn = useOn
  bot.moveVehicle = moveVehicle

  bot._client.on('abilities', (packet) => {
    bot.entity.abilities = {
      flags: packet.flags,
      flyingSpeed: packet.flyingSpeed,
      walkingSpeed: packet.walkingSpeed
    }

    // For convenience, extract boolean flags
    bot.entity.isInvulnerable = (packet.flags & 1) !== 0
    bot.entity.isFlying = (packet.flags & 2) !== 0
    bot.entity.canFly = (packet.flags & 4) !== 0
    bot.entity.canInstantlyBuild = (packet.flags & 8) !== 0

    bot.emit('abilities', bot.entity.abilities)
  })

  function swingArm (arm = 'right', showHand = true) {
    const hand = arm === 'right' ? 0 : 1
    const packet = {}
    if (showHand) packet.hand = hand
    bot._client.write('arm_animation', packet)
  }

  function useOn (target) {
    // TODO: check if not crouching will make make this action always use the item
    useEntity(target, 0)
  }

  function attack (target, swing = true) {
    // arm animation comes before the use_entity packet on 1.8
    if (bot.supportFeature('armAnimationBeforeUse')) {
      if (swing) {
        swingArm()
      }
      useEntity(target, 1)
    } else {
      useEntity(target, 1)
      if (swing) {
        swingArm()
      }
    }
    applySprintAttackSlowdown(target)
  }

  // Vanilla sprint-attack self-slowdown (client-side). A full-strength hit while sprinting is a
  // "knockback attack": the client multiplies the ATTACKER'S OWN horizontal velocity by 0.6 and
  // drops sprint. Gate on SPRINT, not the Knockback enchant: enchantment knockback is applied
  // server-side only, and the attack-knockback attribute is 0 for a normal player, so the only
  // client-side contributor is the sprint-attack.
  //
  // Target-type gate: the 0.6x is reached ONLY when the client-side hurt simulation returns
  // true, which it does for other players and non-living attackables (boats/minecarts,
  // paintings/item frames, items/experience orbs/end crystals ...) but NOT for a regular living
  // mob. So a sprint-attack on a plain living mob (zombie/cow/villager/armor_stand/...) does NOT
  // slow the attacker — applying the 0.6x there would diverge from the vanilla client by ~0.4x
  // horizontal speed. Hence SKIP when the target is a living non-player entity (type in
  // LIVING_ENTITY_TYPE_CATEGORIES and != 'player').
  //
  // The full-cooldown gate (attack strength > 0.9) is NOT modelled here — the fork tracks no
  // attack-cooldown state. Applying on every sprint-attack is safe at default attack speed.
  function applySprintAttackSlowdown (target) {
    if (!bot.entity || !bot.entity.velocity) return
    if (!bot.entity.sprinting) return
    // Target-type gate: vanilla only slows the attacker when the target is a player or a
    // non-living attackable. A living non-player mob gets no slow; applying it anyway would
    // diverge from the vanilla client.
    if (target && target.type !== 'player' && LIVING_ENTITY_TYPE_CATEGORIES.has(target.type)) return
    // vel.multiply(0.6, 1.0, 0.6) -- horizontal only, Y unchanged.
    bot.entity.velocity.x *= 0.6
    bot.entity.velocity.z *= 0.6
    // setSprinting(false): clear the EFFECTIVE sprint flag. physics.js updatePosition ->
    // sendIsSprintingIfNeeded emits the STOP_SPRINTING entity_action in lockstep before the next move
    // packet; the engine re-evaluates canStartSprinting next tick from the held control, exactly like
    // vanilla aiStep after setSprinting(false).
    bot.entity.sprinting = false
  }

  function mount (target) {
    // TODO: check if crouching will make make this action always mount
    useEntity(target, 0)
  }

  function moveVehicle (left, forward, jump = false) {
    if (bot.supportFeature('newPlayerInputPacket')) {
      // docs:
      // * left can take -1 or 1 : -1 means right, 1 means left
      // * forward can take -1 or 1 : -1 means backward, 1 means forward
      bot._client.write('player_input', {
        inputs: {
          forward: forward > 0,
          backward: forward < 0,
          left: left > 0,
          right: left < 0
        }
      })
    } else {
      bot._client.write('steer_vehicle', {
        sideways: left,
        forward,
        jump: jump ? 0x01 : 0x02
      })
    }
  }

  function dismount () {
    if (bot.vehicle) {
      if (bot.supportFeature('newPlayerInputPacket')) {
        bot._client.write('player_input', {
          inputs: {
            jump: true
          }
        })
      } else {
        bot._client.write('steer_vehicle', {
          sideways: 0.0,
          forward: 0.0,
          jump: 0x02
        })
      }
    } else {
      bot.emit('error', new Error('dismount: not mounted'))
    }
  }

  function useEntity (target, leftClick, x, y, z) {
    const sneaking = bot.getControlState('sneak')
    if (bot.supportFeature('useEntityUsesEntityId')) {
      if (leftClick === 1 && bot.supportFeature('attackUsesOwnPacket')) {
        bot._client.write('attack', { entityId: target.id })
        return
      }

      bot._client.write('use_entity', {
        entityId: target.id,
        hand: 0,
        location: {
          x: x ?? 0,
          y: y ?? 0,
          z: z ?? 0
        },
        usingSecondaryAction: sneaking
      })
      return
    }

    if (x && y && z) {
      bot._client.write('use_entity', {
        target: target.id,
        mouse: leftClick,
        x,
        y,
        z,
        sneaking
      })
    } else {
      bot._client.write('use_entity', {
        target: target.id,
        mouse: leftClick,
        sneaking
      })
    }
  }

  function fetchEntity (id) {
    return bot.entities[id] || (bot.entities[id] = new Entity(id))
  }
}

function parseMetadata (metadata, entityMetadata = {}) {
  if (metadata !== undefined) {
    for (const { key, value } of metadata) {
      entityMetadata[key] = value
    }
  }

  return entityMetadata
}

function extractSkinInformation (properties) {
  if (!properties) {
    return undefined
  }

  const props = Object.fromEntries(properties.map((e) => [e.name, e]))
  if (!props.textures || !props.textures.value) {
    return undefined
  }

  let skinTexture
  try { // Handles mojangson-style player data
    skinTexture = JSON.parse(Buffer.from(props.textures.value, 'base64'))
  } catch (e) {
    skinTexture = mojangson.simplify(mojangson.parse(Buffer.from(props.textures.value, 'base64').toString('utf-8')))
  }

  const skinTextureUrl = skinTexture?.textures?.SKIN?.url ?? undefined
  const skinTextureModel = skinTexture?.textures?.SKIN?.metadata?.model ?? undefined

  if (!skinTextureUrl) {
    return undefined
  }

  return { url: skinTextureUrl, model: skinTextureModel }
}
