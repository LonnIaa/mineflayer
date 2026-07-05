const {
  EntityPhysics,
  EPhysicsCtx,
  EntityState,
  PhysicsWorldSettings
} = require('@nxg-org/mineflayer-physics-util')

module.exports = inject

function inject (bot) {
  const physics = new EntityPhysics(bot.registry)
  const settings = bot.physicsSettings ?? new PhysicsWorldSettings(bot.registry)
  const contexts = new Map()

  bot.entityPhysics = {
    contexts,
    settings,
    syncEntity,
    simulateEntity,
    clear: clearContexts
  }

  bot.on('entitySpawn', syncEntity)
  bot.on('entityMoved', syncEntity)
  bot.on('entityVelocity', syncEntity)
  bot.on('entityUpdate', syncEntity)
  bot.on('entityEquip', syncEntity)
  bot.on('entityEffect', syncEntity)
  bot.on('entityEffectEnd', syncEntity)
  bot.on('entityCrouch', syncEntity)
  bot.on('entityUncrouch', syncEntity)

  bot.on('entityGone', (entity) => {
    if (entity?.id != null) contexts.delete(entity.id)
  })

  bot.on('worldSwitch', clearContexts)

  bot.on('entityPhysicsTick', () => {
    for (const entity of Object.values(bot.entities)) {
      simulateEntity(entity)
    }
  })

  function clearContexts () {
    contexts.clear()
  }

  function resolveEntityType (entity) {
    return bot.registry.entities[entity.entityType] ??
      bot.registry.entitiesByName[entity.name] ??
      bot.registry.entitiesByName[`minecraft:${entity.name}`] ??
      null
  }

  function canSimulateEntity (entity) {
    if (!entity || entity === bot.entity || entity.isValid === false) return false
    if (!entity.position || !entity.velocity) return false
    if (typeof entity.height !== 'number' || typeof entity.width !== 'number') return false
    if (entity.type === 'player') return false
    return resolveEntityType(entity) != null
  }

  // Other-entity physics PREDICTION must NEVER crash the bot. syncEntity runs from 9 entity events
  // (entityMoved/Velocity/Spawn/...), so it executes inside the protocol packet-handler stack. A single
  // unsupported entity used to throw an UNCAUGHT TypeError here -- e.g. a non-player entity whose id is
  // absent from EPhysicsCtx.mobData (undefined on the 26.2 root physics-util) at entityPhysicsCtx.js:57 --
  // which unwound the packet handler, starved keep-alives, and got the bot ECONNRESET by the server ~60s
  // later (observed: crash at spawn, disconnect exactly 60s on). Degrade gracefully: drop that entity's
  // context, skip it, warn once. Prediction for the offending entity is disabled; the connection lives.
  let warnedSync = false
  let warnedSim = false
  function syncEntity (entity) {
    try {
      if (!canSimulateEntity(entity)) {
        if (entity?.id != null) contexts.delete(entity.id)
        return null
      }

      const entityType = resolveEntityType(entity)
      let ctx = contexts.get(entity.id)

      if (ctx == null || ctx.entityType !== entityType) {
        const state = EntityState.CREATE_FROM_ENTITY(physics, entity)
        ctx = EPhysicsCtx.FROM_ENTITY_STATE(physics, state, entityType, settings)
        contexts.set(entity.id, ctx)
        return ctx
      }

      ctx.state.updateFromEntity(entity, true)
      ctx.pose = ctx.state.pose

      return ctx
    } catch (err) {
      if (entity?.id != null) contexts.delete(entity.id)
      if (!warnedSync) { warnedSync = true; console.error('[entity_physics] syncEntity skipped an entity (prediction disabled for it):', (err && err.message) || err) }
      return null
    }
  }

  function simulateEntity (entity) {
    try {
      if (!canSimulateEntity(entity)) return null

      const ctx = contexts.get(entity.id)
      if (ctx == null) return null

      if (bot.blockAt(ctx.state.pos) == null) return null

      Object.assign(ctx, settings.overrides)

      physics.simulate(ctx, bot.physicsWorld)
      ctx.state.applyToEntity(entity)
      return ctx.state
    } catch (err) {
      if (entity?.id != null) contexts.delete(entity.id)
      if (!warnedSim) { warnedSim = true; console.error('[entity_physics] simulateEntity skipped an entity:', (err && err.message) || err) }
      return null
    }
  }
}