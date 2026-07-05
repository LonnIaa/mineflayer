const assert = require('assert')
const { toNotchianYaw, toNotchianPitch } = require('../conversions')

module.exports = inject

function inject (bot) {
  const Item = require('prismarine-item')(bot.registry)

  // 26.2+ has per-wood boat/raft entity types (oak_boat, bamboo_raft, oak_chest_boat, ...) — there is
  // no generic 'boat' entity anymore. Older versions (pre-1.21.2) keep a single 'boat'/'chest_boat' type.
  function isBoatItem (itemName) {
    return itemName.endsWith('_boat') || itemName.endsWith('_raft')
  }

  function boatEntityName (itemName) {
    // The per-wood entity's registry name equals the item name (oak_boat item -> oak_boat entity).
    // Fall back to the pre-1.21.2 generic entity when the per-wood type isn't in the registry.
    if (bot.registry.entitiesByName[itemName]) return itemName
    return itemName.includes('chest') ? 'chest_boat' : 'boat'
  }

  /**
   *
   * @param {import('prismarine-block').Block} referenceBlock
   * @param {import('vec3').Vec3} faceVector
   * @param {{forceLook?: boolean | 'ignore', offhand?: boolean, swingArm?: 'right' | 'left', showHand?: boolean}} options
   */
  async function placeEntityWithOptions (referenceBlock, faceVector, options) {
    if (!bot.heldItem) throw new Error('must be holding an item to place an entity')

    const itemName = bot.heldItem.name
    const type = isBoatItem(itemName) // any per-wood boat/raft resolves to the 'boat' code path
      ? 'boat'
      : itemName.replace(/.+_spawn_egg/, 'spawn_egg')
    assert(['end_crystal', 'boat', 'spawn_egg', 'armor_stand'].includes(type), 'Unimplemented')

    let name = isBoatItem(itemName) // entity to find after spawn (26.2 = per-wood, e.g. oak_boat)
      ? boatEntityName(itemName)
      : itemName

    if (name.endsWith('spawn_egg')) {
      name = bot.heldItem.spawnEggMobName
    }

    if (type === 'spawn_egg') {
      options.showHand = false
    }

    if (!options.swingArm) options.swingArm = options.offhand ? 'left' : 'right'

    const pos = await bot._genericPlace(referenceBlock, faceVector, options)

    if (type === 'boat') {
      if (bot.supportFeature('useItemWithOwnPacket')) {
        // 26.2 packet_use_item = {hand, sequence, rotation(vec2f)} — hand-only throws in the serializer.
        // Same BadPacketsJ rule as inventory.js activateItem: use the wire rotation the move packet last
        // sent (_lastSentRotation) so use_item's yaw/pitch equals the same tick's flying packet; fall back
        // to the raw conversion only before the first send.
        const wire = bot._lastSentRotation
        bot._client.write('use_item', {
          hand: options.offhand ? 1 : 0,
          sequence: 0,
          rotation: wire
            ? { x: wire.yaw, y: wire.pitch }
            : { x: toNotchianYaw(bot.entity.yaw), y: toNotchianPitch(bot.entity.pitch) }
        })
      } else {
        bot._client.write('block_place', {
          location: { x: -1, y: -1, z: -1 },
          direction: -1,
          heldItem: Item.toNotch(bot.heldItem),
          cursorX: 0,
          cursorY: 0,
          cursorZ: 0
        })
      }
    }

    const dest = pos.plus(faceVector)
    const entity = await waitForEntitySpawn(name, dest)
    bot.emit('entityPlaced', entity)
    return entity
  }

  async function placeEntity (referenceBlock, faceVector) {
    return await placeEntityWithOptions(referenceBlock, faceVector, {})
  }

  function waitForEntitySpawn (name, placePosition) {
    const maxDistance = name === 'bat' ? 4 : (isBoatItem(name) || name === 'boat') ? 3 : 2
    let mobName = name
    if (name === 'end_crystal') {
      if (bot.supportFeature('enderCrystalNameEndsInErNoCaps')) {
        mobName = 'ender_crystal'
      } else if (bot.supportFeature('entityNameLowerCaseNoUnderscore')) {
        mobName = 'endercrystal'
      } else if (bot.supportFeature('enderCrystalNameNoCapsWithUnderscore')) {
        mobName = 'end_crystal'
      } else {
        mobName = 'EnderCrystal'
      }
    } else if (name === 'boat') {
      mobName = bot.supportFeature('entityNameUpperCaseNoUnderscore') ? 'Boat' : 'boat'
    } else if (name === 'armor_stand') {
      if (bot.supportFeature('entityNameUpperCaseNoUnderscore')) {
        mobName = 'ArmorStand'
      } else if (bot.supportFeature('entityNameLowerCaseNoUnderscore')) {
        mobName = 'armorstand'
      } else {
        mobName = 'armor_stand'
      }
    }

    return new Promise((resolve, reject) => {
      function listener (entity) {
        const dist = entity.position.distanceTo(placePosition)
        if (entity.name === mobName && dist < maxDistance) {
          resolve(entity)
        }
        bot.off('entitySpawn', listener)
      }

      setTimeout(() => {
        bot.off('entitySpawn', listener)
        reject(new Error('Failed to place entity'))
      }, 5000) // reject after 5s

      bot.on('entitySpawn', listener)
    })
  }

  bot.placeEntity = placeEntity
  bot._placeEntityWithOptions = placeEntityWithOptions
}
